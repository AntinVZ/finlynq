/**
 * src/lib/mcp/activity-log.ts — the MCP activity journal (S3). DB-free: the
 * executor records the INSERT; a real McpServer exercises the tools/call wrap.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SQL } from "drizzle-orm";
import { renderSql } from "./helpers/tag-ledger";
import {
  CALL_TOOL_METHOD,
  extractOp,
  instrumentCallTool,
  isWriteCall,
  logMcpActivity,
  summarizeToolResult,
} from "@/lib/mcp/activity-log";

const text = (t: string) => ({ content: [{ type: "text", text: t }] });

describe("is_write classification", () => {
  it("read-prefixed tools are never writes", () => {
    expect(isWriteCall("get_net_worth", null)).toBe(false);
    expect(isWriteCall("search_transactions", null)).toBe(false);
    expect(isWriteCall("preview_bulk_update", null)).toBe(false);
  });
  it("manage_* depends on op", () => {
    expect(isWriteCall("manage_tags", "list")).toBe(false);
    expect(isWriteCall("manage_categories", "merge")).toBe(true);
    expect(isWriteCall("manage_accounts", "create")).toBe(true);
    expect(isWriteCall("manage_bank_ledger", "list_rows")).toBe(false);
  });
  it("write tools without op are writes", () => {
    expect(isWriteCall("record_transaction", null)).toBe(true);
    expect(isWriteCall("execute_bulk_update", null)).toBe(true);
  });
  it("op is only taken when it is a plain identifier", () => {
    expect(extractOp({ op: "merge" })).toBe("merge");
    expect(extractOp({ op: "drop table; --" })).toBeNull();
    expect(extractOp({ op: 3 })).toBeNull();
    expect(extractOp(null)).toBeNull();
  });
});

describe("summarizeToolResult", () => {
  it("success with a count", () => {
    expect(summarizeToolResult(text(JSON.stringify({ success: true, data: { changed: 4 } })))).toEqual({
      ok: true, errorCode: null, affectedCount: 4, isPreview: false,
    });
  });
  it("err() text and isError are failures", () => {
    expect(summarizeToolResult(text("Error: Category #3 not found.")).ok).toBe(false);
    expect(summarizeToolResult({ ...text("boom"), isError: true })).toMatchObject({ ok: false, errorCode: "tool_error" });
  });
  it("a two-step preview is flagged", () => {
    const r = summarizeToolResult(text(JSON.stringify({ success: true, data: { preview: true, confirmationToken: "t" } })));
    expect(r.isPreview).toBe(true);
  });
  it("structured failure keeps a safe code only", () => {
    expect(summarizeToolResult(text(JSON.stringify({ success: false, code: "not_found" }))).errorCode).toBe("not_found");
    expect(summarizeToolResult(text(JSON.stringify({ success: false, code: "x y <script>" }))).errorCode).toBe("tool_error");
  });
});

function recorder(fail = false) {
  const log: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute: vi.fn(async (q: SQL) => {
      log.push(renderSql(q));
      if (fail) throw new Error("db down");
      return { rows: [] };
    }),
  };
  return { db, log };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("logMcpActivity", () => {
  it("writes labels only and resolves the OAuth client name in SQL", async () => {
    const { db, log } = recorder();
    logMcpActivity(db, {
      userId: "u1", client: { kind: "oauth", clientId: "cid" }, tool: "manage_tags", op: "rename",
      isWrite: true, ok: true, errorCode: null, affectedCount: 3,
    });
    await flush();
    expect(log[0].sql).toMatch(/INSERT INTO mcp_activity_log/);
    expect(log[0].sql).toMatch(/SELECT client_name FROM oauth_clients/);
    expect(log[0].params).toEqual(["u1", "cid", "cid", "manage_tags", "rename", true, true, null, 3]);
  });

  it("never throws or rejects when the DB fails", async () => {
    const { db } = recorder(true);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    expect(() =>
      logMcpActivity(db, { userId: "u", client: { kind: "api_key" }, tool: "t", op: null, isWrite: false, ok: true, errorCode: null, affectedCount: null }),
    ).not.toThrow();
    await flush();
    await flush();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("instrumentCallTool (single tools/call point)", () => {
  function server(handlerResult: () => unknown) {
    const s = new McpServer({ name: "t", version: "0" });
    s.tool("manage_widgets", { op: z.string(), secret: z.string().optional() }, async () => handlerResult() as never);
    s.tool("get_widgets", {}, async () => text(JSON.stringify({ success: true, data: { count: 9 } })) as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (s.server as any)._requestHandlers as Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  }
  const call = (handlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>, name: string, args: unknown) =>
    handlers.get(CALL_TOOL_METHOD)!({ method: "tools/call", params: { name, arguments: args } }, { signal: new AbortController().signal, requestId: 1, sendNotification: async () => {}, sendRequest: async () => ({}) });

  it("uses the SDK's tools/call method name", () => {
    expect(CALL_TOOL_METHOD).toBe(CallToolRequestSchema.shape.method.value);
  });

  it("logs a write with its count and passes the result through untouched", async () => {
    const result = text(JSON.stringify({ success: true, data: { changed: 2 } }));
    const handlers = server(() => result);
    const { db, log } = recorder();
    instrumentCallTool(handlers, { db, userId: "u1", client: { kind: "api_key" } });
    const out = await call(handlers, "manage_widgets", { op: "rename", secret: "Шляхов salary" });
    expect(out).toEqual(result);
    await flush();
    expect(log).toHaveLength(1);
    expect(log[0].params).toEqual(["u1", "API key", "manage_widgets", "rename", true, true, null, 2]);
    // Arguments are never stored.
    expect(JSON.stringify(log[0].params)).not.toContain("salary");
  });

  it("a preview is logged as a read", async () => {
    const handlers = server(() => text(JSON.stringify({ success: true, data: { preview: true, confirmationToken: "x" } })));
    const { db, log } = recorder();
    instrumentCallTool(handlers, { db, userId: "u1", client: { kind: "session" } });
    await call(handlers, "manage_widgets", { op: "delete" });
    await flush();
    expect(log[0].params).toEqual(["u1", "Browser session", "manage_widgets", "delete", false, true, null, null]);
  });

  it("read counts are not stored as affected rows", async () => {
    const handlers = server(() => text("{}"));
    const { db, log } = recorder();
    instrumentCallTool(handlers, { db, userId: "u1", client: { kind: "api_key" } });
    await call(handlers, "get_widgets", {});
    await flush();
    expect(log[0].params.slice(-4)).toEqual([false, true, null, null]);
  });

  it("a failing journal never breaks the call", async () => {
    const result = text(JSON.stringify({ success: true, data: { changed: 1 } }));
    const handlers = server(() => result);
    const { db } = recorder(true);
    instrumentCallTool(handlers, { db, userId: "u1", client: { kind: "api_key" } });
    await expect(call(handlers, "manage_widgets", { op: "rename" })).resolves.toEqual(result);
  });

  it("a tool error is logged as not ok", async () => {
    const handlers = server(() => text("Error: nope"));
    const { db, log } = recorder();
    instrumentCallTool(handlers, { db, userId: "u1", client: { kind: "api_key" } });
    await call(handlers, "manage_widgets", { op: "update" });
    await flush();
    expect(log[0].params.slice(-3)).toEqual([false, "tool_error", null]);
  });
});
