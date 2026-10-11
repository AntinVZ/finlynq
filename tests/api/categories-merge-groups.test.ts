/**
 * POST /api/categories/merge and POST /api/categories/groups (Settings →
 * Categorization). DB-free: `db.execute` is served from a tiny in-memory
 * category list, writes are recorded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { renderSql } from "../helpers/tag-ledger";

type Cat = { id: number; userId: string; type: string; group: string };
let cats: Cat[] = [];
let log: Array<{ sql: string; params: unknown[] }> = [];
let budgetConflicts = 0;
let failWith: Error | null = null;
const invalidate = vi.fn();

vi.mock("@/lib/auth/require-encryption", () => ({
  requireEncryption: vi.fn(async () => ({ ok: true, userId: "userA", dek: Buffer.alloc(32, 1), sessionId: "s" })),
}));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "userA", dek: null } })),
}));
vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: (...a: unknown[]) => invalidate(...a) }));

async function execute(q: SQL) {
  const r = renderSql(q);
  log.push(r);
  const s = r.sql;
  if (failWith && /^\s*UPDATE budgets/.test(s)) throw failWith;
  if (/SELECT id, type FROM categories/.test(s)) {
    const [uid, a, b] = r.params as [string, number, number];
    return { rows: cats.filter((c) => c.userId === uid && (c.id === a || c.id === b)) };
  }
  if (/FROM budgets s\s+JOIN budgets t/.test(s)) return { rows: [{ cnt: budgetConflicts }] };
  if (/SELECT COUNT\(\*\) AS cnt FROM transactions WHERE/.test(s)) return { rows: [{ cnt: 4 }] };
  if (/SELECT COUNT\(\*\) AS cnt/.test(s)) return { rows: [{ cnt: 0 }] };
  if (/SELECT COUNT\(\*\) AS n FROM categories/.test(s)) {
    const [uid, g] = r.params as [string, string];
    return { rows: [{ n: cats.filter((c) => c.userId === uid && c.group === g).length }] };
  }
  if (/^\s*UPDATE categories SET "group"/.test(s)) {
    const [to, uid, from] = r.params as [string, string, string];
    const hit = cats.filter((c) => c.userId === uid && c.group === from);
    hit.forEach((c) => (c.group = to));
    return { rows: hit.map((c) => ({ id: c.id })) };
  }
  return { rows: [], rowCount: 0 };
}

vi.mock("@/db", () => ({
  db: {
    execute: (q: SQL) => execute(q),
    transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) => fn({ execute }),
  },
}));

import { POST as MERGE } from "@/app/api/categories/merge/route";
import { POST as GROUPS } from "@/app/api/categories/groups/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const merge = async (body: unknown) =>
  parseResponse(await MERGE(createMockRequest("http://localhost:3000/api/categories/merge", { method: "POST", body })));
const groups = async (body: unknown) =>
  parseResponse(await GROUPS(createMockRequest("http://localhost:3000/api/categories/groups", { method: "POST", body })));

beforeEach(() => {
  log = [];
  budgetConflicts = 0;
  failWith = null;
  invalidate.mockClear();
  cats = [
    { id: 1, userId: "userA", type: "E", group: "Food" },
    { id: 2, userId: "userA", type: "E", group: "Food" },
    { id: 3, userId: "userA", type: "I", group: "Work" },
    { id: 9, userId: "userB", type: "E", group: "Food" },
  ];
});

const writes = () => log.filter((l) => /^\s*(UPDATE|DELETE)/.test(l.sql));

describe("POST /api/categories/merge", () => {
  it("dryRun returns per-type counts and writes nothing", async () => {
    const { status, data } = await merge({ sourceId: 1, targetId: 2, dryRun: true });
    expect(status).toBe(200);
    expect(data).toMatchObject({ dryRun: true, totalDependents: 4, budgetConflicts: 0, typeMismatch: false });
    expect(writes()).toHaveLength(0);
  });

  it("merges: repoints every FK table and deletes the source", async () => {
    const { status, data } = await merge({ sourceId: 1, targetId: 2 });
    expect(status).toBe(200);
    expect(data).toMatchObject({ merged: true, repointed: { transactions: 4 } });
    expect(writes()).toHaveLength(9);
    expect(writes().at(-1)!.sql).toMatch(/DELETE FROM categories/);
    expect(invalidate).toHaveBeenCalledWith("userA");
  });

  it("flags a type mismatch in the preview", async () => {
    const { data } = await merge({ sourceId: 1, targetId: 3, dryRun: true });
    expect(data).toMatchObject({ typeMismatch: true });
  });

  it("404s on another user's category", async () => {
    const { status } = await merge({ sourceId: 1, targetId: 9 });
    expect(status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  it("400s when source = target", async () => {
    expect((await merge({ sourceId: 1, targetId: 1 })).status).toBe(400);
  });

  it("409s up front on same-month budgets", async () => {
    budgetConflicts = 2;
    const { status, data } = await merge({ sourceId: 1, targetId: 2 });
    expect(status).toBe(409);
    expect(data).toMatchObject({ code: "budget_conflict" });
    expect(writes()).toHaveLength(0);
  });

  it("maps a unique violation inside the merge to 409", async () => {
    failWith = Object.assign(new Error("dup"), { code: "23505" });
    const { status, data } = await merge({ sourceId: 1, targetId: 2 });
    expect(status).toBe(409);
    expect(data).toMatchObject({ code: "conflict" });
  });
});

describe("POST /api/categories/groups", () => {
  it("dryRun previews affected categories and an existing target", async () => {
    cats.push({ id: 4, userId: "userA", type: "E", group: "Home" });
    const { status, data } = await groups({ from: "Food", to: "Home", dryRun: true });
    expect(status).toBe(200);
    expect(data).toMatchObject({ affected: 2, targetExists: true, targetCount: 1, updated: 0 });
    expect(writes()).toHaveLength(0);
  });

  it("renames the group on the caller's categories only", async () => {
    const { data } = await groups({ from: "Food", to: "Groceries" });
    expect(data).toMatchObject({ affected: 2, updated: 2 });
    expect(cats.filter((c) => c.group === "Groceries").map((c) => c.id)).toEqual([1, 2]);
    expect(cats.find((c) => c.id === 9)!.group).toBe("Food");
  });

  it("400s on an empty new name", async () => {
    expect((await groups({ from: "Food", to: "  " })).status).toBe(400);
  });
});
