/**
 * MCP preview_bulk_update / execute_bulk_update — `changes.add_tags` and
 * `changes.remove_tags` (T1). DB-free: the tools run against a mock `execute`
 * that serves a newest-first ledger with real ciphertext; the tag writes go
 * through the shared batch writer, served by tests/helpers/tag-ledger.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

const invalidate = vi.fn();
vi.mock("@/lib/mcp/user-tx-cache", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/mcp/user-tx-cache");
  return { ...actual, invalidateUser: (...a: unknown[]) => invalidate(...a) };
});
vi.mock("@/lib/transactions/snapshot-dirty-for-tx", () => ({ stampSnapshotDirtyForTxIds: async () => {} }));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SQL } from "drizzle-orm";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";
import { encryptField, decryptField } from "../../src/lib/crypto/envelope";
import { renderSql, serveTagSql, isTagCaseUpdate, type LedgerRow } from "../helpers/tag-ledger";

type Tool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

const dek = Buffer.alloc(32, 5);
let executed: string[] = [];
let ledger: LedgerRow[] = [];
let tools: Record<string, Tool>;

const enc = (s: string) => encryptField(dek, s);
const plain = (id: number) => decryptField(dek, ledger.find((r) => r.id === id)!.tags ?? "") ?? "";

const isTextScan = (s: string) => s.includes("SELECT id, payee, note, tags FROM transactions");
const isIdScan = (s: string) => /SELECT id FROM transactions\s+WHERE[\s\S]*ORDER BY date DESC, id DESC/.test(s);
const isSample = (s: string) => /SELECT t\.id, t\.date, t\.account_id/.test(s);

beforeAll(() => {
  const server = withAutoAnnotations(new McpServer({ name: "bulk-tags-test", version: "0.0.0" }));
  registerPgTools(
    server,
    {
      execute: async (query: SQL) => {
        const r = renderSql(query);
        executed.push(r.sql);
        const own = ledger.filter((x) => x.userId === "user-1");
        const served = serveTagSql(ledger, r);
        if (served) return served;
        if (isTextScan(r.sql)) {
          const [size, offset] = r.params.slice(-2) as [number, number];
          const rows = own.slice(offset, offset + size).map((x) => ({ id: x.id, payee: null, note: null, tags: x.tags }));
          return { rows, rowCount: rows.length };
        }
        if (isIdScan(r.sql)) {
          const size = r.params[r.params.length - 1] as number;
          const rows = own.slice(0, size).map((x) => ({ id: x.id }));
          return { rows, rowCount: rows.length };
        }
        if (isSample(r.sql)) {
          const ids = r.params.filter((p) => typeof p === "number") as number[];
          const rows = own.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, tags: x.tags, payee: null, note: null }));
          return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    "user-1",
    dek,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools = (server as any)._registeredTools as Record<string, Tool>;
});

beforeEach(() => {
  executed = [];
  invalidate.mockClear();
  ledger = [
    { id: 3, userId: "user-1", tags: enc("Acme,travel") },
    { id: 2, userId: "user-1", tags: enc("work,homework") },
    { id: 1, userId: "user-1", tags: null },
    { id: 9, userId: "user-2", tags: enc("work") },
  ];
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await tools[name].handler(args, {});
  const raw = res.content[0].text;
  let body: Record<string, unknown> & { data?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    body = { error: raw };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: res.isError === true || raw.startsWith("Error:"), raw, data: (body.data ?? body) as any };
};

const previewThenExecute = async (filter: Record<string, unknown>, changes: Record<string, unknown>) => {
  const prev = await call("preview_bulk_update", { filter, changes });
  expect(prev.isError).toBe(false);
  expect(typeof prev.data.confirmationToken).toBe("string");
  const exec = await call("execute_bulk_update", { filter, changes, confirmation_token: prev.data.confirmationToken });
  return { prev, exec };
};

describe("changes.add_tags", () => {
  it("preview shows the per-row result; execute writes only changed rows", async () => {
    const { prev, exec } = await previewThenExecute({ ids: [1, 2, 3] }, { add_tags: "ACME " });
    const after = Object.fromEntries((prev.data.sampleAfter as Array<{ id: number; tags: string }>).map((r) => [r.id, r.tags]));
    expect(after).toEqual({ 1: "ACME", 2: "work,homework,ACME", 3: "Acme,travel" });
    expect(exec.isError).toBe(false);
    expect(plain(3)).toBe("Acme,travel");
    expect(plain(2)).toBe("work,homework,ACME");
    expect(plain(1)).toBe("ACME");
    expect(ledger.find((r) => r.id === 3)!.updatedAt).toBeUndefined();
    expect(ledger.find((r) => r.id === 2)!.updatedAt).toBe("NOW");
    expect(invalidate).toHaveBeenCalledWith("user-1");
  });

  it("accepts an array", async () => {
    await previewThenExecute({ ids: [1] }, { add_tags: ["trip", "Lviv", "TRIP"] });
    expect(plain(1)).toBe("trip,Lviv");
  });

  it("never writes another user's row", async () => {
    await previewThenExecute({ ids: [9, 2] }, { add_tags: "x" });
    expect(decryptField(dek, ledger.find((r) => r.id === 9)!.tags!)).toBe("work");
  });
});

describe("changes.remove_tags", () => {
  it("removes whole tags only", async () => {
    await previewThenExecute({ tag_exact: "work" }, { remove_tags: "WORK" });
    expect(plain(2)).toBe("homework");
  });

  it("add + remove in one call", async () => {
    await previewThenExecute({ ids: [2] }, { add_tags: "new", remove_tags: ["homework"] });
    expect(plain(2)).toBe("work,new");
  });
});

describe("conflicts and bounds", () => {
  it("tags + add_tags is refused with a clear error and no token", async () => {
    const prev = await call("preview_bulk_update", {
      filter: { ids: [1] },
      changes: { tags: { mode: "replace", value: "a" }, add_tags: "b" },
    });
    expect(prev.isError).toBe(true);
    expect(prev.raw).toMatch(/can't be combined/);
    const exec = await call("execute_bulk_update", {
      filter: { ids: [1] },
      changes: { tags: { mode: "append", value: "a" }, remove_tags: "b" },
      confirmation_token: "x",
    });
    expect(exec.isError).toBe(true);
    expect(executed.some(isTagCaseUpdate)).toBe(false);
  });

  it("an empty add_tags is unapplied and mints no token", async () => {
    const prev = await call("preview_bulk_update", { filter: { ids: [1] }, changes: { add_tags: " , " } });
    expect(prev.data.unappliedChanges[0].field).toBe("add_tags");
    expect(prev.data.confirmationToken).toBe("");
  });

  it("truncated match set → no token; execute refuses and writes nothing", async () => {
    ledger = Array.from({ length: 10_001 }, (_, i) => ({ id: 20_000 - i, userId: "user-1", tags: null }));
    const prev = await call("preview_bulk_update", { filter: { start_date: "2020-01-01" }, changes: { add_tags: "x" } });
    expect(prev.data.truncated).toBe(true);
    expect(prev.data.confirmationToken).toBeUndefined();
    const exec = await call("execute_bulk_update", {
      filter: { start_date: "2020-01-01" },
      changes: { add_tags: "x" },
      confirmation_token: "anything",
    });
    expect(exec.isError).toBe(true);
    expect(exec.raw).toMatch(/Refusing to execute/);
    expect(executed.some(isTagCaseUpdate)).toBe(false);
  });

  it("legacy tags append mode now dedupes by normalized identity", async () => {
    await previewThenExecute({ ids: [3] }, { tags: { mode: "append", value: "TRAVEL,new" } });
    expect(plain(3)).toBe("Acme,travel,new");
  });
});
