/**
 * MCP manage_tags (T3): list / rename / merge / delete with preview →
 * confirmation_token. DB-free: tests/helpers/tag-ledger serves the tag scan,
 * the batch SELECT and the CASE UPDATE over an in-memory ledger with real
 * ciphertext.
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SQL } from "drizzle-orm";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";
import { encryptField, decryptField } from "../../src/lib/crypto/envelope";
import { renderSql, serveTagSql, isTagCaseUpdate, type LedgerRow } from "../helpers/tag-ledger";

type Tool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

const dek = Buffer.alloc(32, 3);
let ledger: LedgerRow[] = [];
let executed: string[] = [];
let tools: Record<string, Tool>;

const enc = (s: string) => encryptField(dek, s);
const plain = (id: number) => decryptField(dek, ledger.find((r) => r.id === id)!.tags ?? "") ?? "";

beforeAll(() => {
  const server = withAutoAnnotations(new McpServer({ name: "manage-tags-test", version: "0.0.0" }));
  registerPgTools(
    server,
    {
      execute: async (query: SQL) => {
        const r = renderSql(query);
        executed.push(r.sql);
        return serveTagSql(ledger, r) ?? { rows: [], rowCount: 0 };
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
    { id: 1, userId: "user-1", tags: enc("Agrotrade,travel"), date: "2026-01-10" },
    { id: 2, userId: "user-1", tags: enc("agrotrade "), date: "2026-02-10", isBusiness: 1 },
    { id: 3, userId: "user-1", tags: enc("agro,work"), date: "2026-03-10" },
    { id: 4, userId: "user-1", tags: enc("homework"), date: "2026-04-10" },
    { id: 5, userId: "user-1", tags: null },
    { id: 6, userId: "user-2", tags: enc("agro,work"), date: "2026-01-01" },
  ];
});

const call = async (args: Record<string, unknown>) => {
  const res = await tools.manage_tags.handler(args, {});
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

const commit = async (args: Record<string, unknown>) => {
  const prev = await call(args);
  expect(prev.isError).toBe(false);
  expect(typeof prev.data.confirmationToken).toBe("string");
  const done = await call({ ...args, confirmation_token: prev.data.confirmationToken });
  return { prev, done };
};

describe("op: list", () => {
  it("lists tags with counts, dates and variant flags (own rows only)", async () => {
    const { data } = await call({ op: "list" });
    const byTag = Object.fromEntries((data.tags as Array<{ tag: string; count: number }>).map((t) => [t.tag, t]));
    expect(Object.keys(byTag)).toEqual(["Agrotrade", "agro", "homework", "travel", "work"]);
    expect(byTag.Agrotrade).toMatchObject({ count: 2, firstDate: "2026-01-10", lastDate: "2026-02-10", hasVariants: true });
    expect(byTag.work.count).toBe(1);
    expect(data.truncated).toBe(false);
  });

  it("business and search narrow the list", async () => {
    expect((await call({ op: "list", business: true })).data.tags.map((t: { tag: string }) => t.tag)).toEqual(["agrotrade"]);
    expect((await call({ op: "list", search: "AGRO" })).data.total).toBe(2);
  });
});

describe("op: rename", () => {
  it("preview counts rows, commit rewrites them and bumps updated_at", async () => {
    const { prev, done } = await commit({ op: "rename", tag: "work", new_name: "Job" });
    expect(prev.data.affectedCount).toBe(1);
    expect(prev.data.targetExists).toBe(false);
    expect(done.data.changed).toBe(1);
    expect(plain(3)).toBe("agro,Job");
    expect(plain(4)).toBe("homework");
    expect(ledger[2].updatedAt).toBe("NOW");
    expect(decryptField(dek, ledger[5].tags!)).toBe("agro,work");
    expect(invalidate).toHaveBeenCalledWith("user-1");
  });

  it("renaming onto an existing tag says it merges", async () => {
    const { prev } = await commit({ op: "rename", tag: "agro", new_name: "AGROTRADE" });
    expect(prev.data.targetExists).toBe(true);
    expect(prev.data.mergeNote).toMatch(/already exists on 2/);
    expect(plain(3)).toBe("AGROTRADE,work");
  });

  it("unifies spellings", async () => {
    await commit({ op: "rename", tag: "agrotrade", new_name: "Agrotrade" });
    expect(plain(2)).toBe("Agrotrade");
    expect(ledger[0].updatedAt).toBeUndefined(); // already spelled that way
  });
});

describe("op: merge", () => {
  it("merges several tags into an existing one", async () => {
    const { prev, done } = await commit({ op: "merge", tags: ["agro", "travel"], into: "Agrotrade" });
    expect(prev.data.affectedCount).toBe(2);
    expect(done.data.changed).toBe(2);
    expect(plain(1)).toBe("Agrotrade");
    expect(plain(3)).toBe("Agrotrade,work");
  });
});

describe("op: delete", () => {
  it("removes the tag only; work ≠ homework", async () => {
    const { prev, done } = await commit({ op: "delete", tags: "WORK" });
    expect(prev.data.affectedCount).toBe(1);
    expect(prev.data.deleteNote).toMatch(/transactions stay/);
    expect(done.data.changed).toBe(1);
    expect(plain(3)).toBe("agro");
    expect(plain(4)).toBe("homework");
    expect(ledger).toHaveLength(6);
  });
});

describe("tokens and limits", () => {
  it("no match → no token", async () => {
    const { data } = await call({ op: "delete", tags: "nope" });
    expect(data.affectedCount).toBe(0);
    expect(data.confirmationToken).toBeUndefined();
  });

  it("a bad token or one for other arguments is refused, nothing written", async () => {
    const prev = await call({ op: "delete", tags: "work" });
    const wrongArgs = await call({ op: "delete", tags: "agro", confirmation_token: prev.data.confirmationToken });
    expect(wrongArgs.isError).toBe(true);
    const garbage = await call({ op: "rename", tag: "work", new_name: "x", confirmation_token: "garbage" });
    expect(garbage.isError).toBe(true);
    expect(executed.some(isTagCaseUpdate)).toBe(false);
  });

  it("rows changing between preview and commit invalidate the token", async () => {
    const prev = await call({ op: "delete", tags: "work" });
    ledger.push({ id: 7, userId: "user-1", tags: enc("work") });
    const done = await call({ op: "delete", tags: "work", confirmation_token: prev.data.confirmationToken });
    expect(done.isError).toBe(true);
    expect(plain(3)).toBe("agro,work");
  });

  it("over 10,000 affected rows → no token; commit refused", async () => {
    ledger = Array.from({ length: 10_001 }, (_, i) => ({ id: i + 1, userId: "user-1", tags: "bulk" }));
    const prev = await call({ op: "delete", tags: "bulk" });
    expect(prev.data.truncated).toBe(true);
    expect(prev.data.confirmationToken).toBeUndefined();
    const done = await call({ op: "delete", tags: "bulk", confirmation_token: "x" });
    expect(done.isError).toBe(true);
    expect(done.raw).toMatch(/Refusing/);
    expect(executed.some(isTagCaseUpdate)).toBe(false);
  });

  it("bad input is a clear error", async () => {
    expect((await call({ op: "rename", tag: "work", new_name: "a,b" })).isError).toBe(true);
    expect((await call({ op: "merge", tags: [], into: "x" })).isError).toBe(true);
  });
});
