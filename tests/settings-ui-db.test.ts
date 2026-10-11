/**
 * Settings UI (S1 + S3) SQL against a real Postgres. SKIPS unless
 * DATABASE_URL names a `*_test` database (same gate as the other DB-backed
 * suites), so the default `vitest run` stays DB-free.
 *
 * Run: DATABASE_URL=postgres://…/finlynq_test npx vitest run tests/settings-ui-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Routes run for real against the DB; only the session is stubbed.
let authedUser = "";
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: authedUser, method: "account", dek: Buffer.alloc(32, 0xaa), sessionId: "test-session" },
  })),
}));

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import {
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
  recordTransaction,
} from "./helpers/portfolio-fixtures";
import { createMockRequest, parseResponse } from "./helpers/api-test-utils";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Rows<T> = { rows: T[] };

describeDb("Settings UI SQL (seeded DB)", () => {
  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });

  it("merge core: budget month conflicts are counted, and a clash rolls the whole merge back", async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    const { countBudgetMonthConflicts, mergeCategoryInto } = await import("@/lib/categories/merge");
    const userId = await createTestUser();
    const accountId = await createAccount({ userId, name: "Chequing", currency: "USD", isInvestment: false });
    const src = await createCategory({ userId, name: "Dining", type: "E" });
    const tgt = await createCategory({ userId, name: "Food", type: "E" });
    await recordTransaction({ userId, accountId, categoryId: src, currency: "USD", amount: -10 });
    await db.execute(sql`DELETE FROM budgets WHERE user_id = ${userId}`);
    await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${src}, '2026-07', 100, 'USD'), (${userId}, ${tgt}, '2026-07', 50, 'USD')`);
    expect(await countBudgetMonthConflicts(db, userId, src, tgt)).toBe(1);

    await expect(mergeCategoryInto(db, userId, src, tgt)).rejects.toBeTruthy();
    // Nothing half-merged: the transaction is still on the source, which still exists.
    const tx = (await db.execute(sql`SELECT category_id FROM transactions WHERE user_id = ${userId}`)) as unknown as Rows<{ category_id: number }>;
    expect(Number(tx.rows[0].category_id)).toBe(src);
    const cats = (await db.execute(sql`SELECT id FROM categories WHERE id = ${src}`)) as unknown as Rows<unknown>;
    expect(cats.rows).toHaveLength(1);

    await db.execute(sql`DELETE FROM budgets WHERE user_id = ${userId} AND category_id = ${tgt}`);
    expect(await countBudgetMonthConflicts(db, userId, src, tgt)).toBe(0);
    const moved = await mergeCategoryInto(db, userId, src, tgt);
    expect(moved.transactions).toBe(1);
    expect(moved.budgets).toBe(1);
  });

  it("counts per category and the type-change guard", async () => {
    await resetTestDb();
    const { getTransactionCountsByCategory } = await import("@/lib/queries");
    const { getCategoryTypeChangeBlock } = await import("@/lib/transactions/sign-category-invariant");
    const userId = await createTestUser();
    const accountId = await createAccount({ userId, name: "Chequing", currency: "USD", isInvestment: false });
    const used = await createCategory({ userId, name: "Groceries", type: "E" });
    const empty = await createCategory({ userId, name: "Spare", type: "E" });
    await recordTransaction({ userId, accountId, categoryId: used, currency: "USD", amount: -10 });
    await recordTransaction({ userId, accountId, categoryId: used, currency: "USD", amount: -20 });

    const counts = await getTransactionCountsByCategory(userId);
    expect(counts.get(used)).toBe(2);
    expect(counts.has(empty)).toBe(false);

    expect(await getCategoryTypeChangeBlock(userId, used, "E")).toBeNull(); // same type
    expect(await getCategoryTypeChangeBlock(userId, empty, "I")).toBeNull(); // unused
    const block = await getCategoryTypeChangeBlock(userId, used, "I");
    expect(block).toMatchObject({ currentType: "E", transactions: 2, splits: 0 });
    expect(await getCategoryTypeChangeBlock("someone-else", used, "I")).toBeNull();
  });

  it("categories routes: withCounts, type guard, merge preview + merge", async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    const userId = await createTestUser();
    authedUser = userId;
    const accountId = await createAccount({ userId, name: "Chequing", currency: "USD", isInvestment: false });
    const src = await createCategory({ userId, name: "Dining", type: "E" });
    const tgt = await createCategory({ userId, name: "Food", type: "E" });
    await recordTransaction({ userId, accountId, categoryId: src, currency: "USD", amount: -10 });
    await db.execute(sql`INSERT INTO transaction_rules (user_id, name, conditions, actions, priority, created_at) VALUES (${userId}, 'r', '[]'::jsonb, ${JSON.stringify([{ kind: "set_tags", tags: "x" }, { kind: "set_category", categoryId: src }])}::jsonb, 0, now()::text)`);

    const cats = await import("@/app/api/categories/route");
    const list = (await parseResponse(await cats.GET(createMockRequest("http://localhost:3000/api/categories?withCounts=1")))).data as Array<{ id: number; name: string; txCount: number }>;
    expect(list.find((c) => c.id === src)).toMatchObject({ name: "Dining", txCount: 1 });
    expect(list.find((c) => c.id === tgt)).toMatchObject({ txCount: 0 });

    const put = async (body: unknown) => parseResponse(await cats.PUT(createMockRequest("http://localhost:3000/api/categories", { method: "PUT", body })));
    expect((await put({ id: src, type: "I" })).status).toBe(409);
    expect((await put({ id: tgt, type: "I", note: "side gig" })).status).toBe(200);
    const noteRow = (await db.execute(sql`SELECT type, note FROM categories WHERE id = ${tgt}`)) as unknown as Rows<{ type: string; note: string }>;
    expect(noteRow.rows[0].type).toBe("I");
    expect(noteRow.rows[0].note).not.toBe("side gig"); // stored encrypted
    await put({ id: tgt, type: "E" });

    const { POST: MERGE } = await import("@/app/api/categories/merge/route");
    const merge = async (body: unknown) => parseResponse(await MERGE(createMockRequest("http://localhost:3000/api/categories/merge", { method: "POST", body })));
    const dry = await merge({ sourceId: src, targetId: tgt, dryRun: true });
    expect(dry.data).toMatchObject({ dryRun: true, dependents: { transactions: 1, rules: 1 }, budgetConflicts: 0, typeMismatch: false });
    const done = await merge({ sourceId: src, targetId: tgt });
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ merged: true, repointed: { transactions: 1, rules: 1 } });
    const rule = (await db.execute(sql`SELECT actions FROM transaction_rules WHERE user_id = ${userId}`)) as unknown as Rows<{ actions: Array<Record<string, unknown>> }>;
    expect(rule.rows[0].actions).toEqual([{ kind: "set_tags", tags: "x" }, { kind: "set_category", categoryId: tgt }]);
    const gone = (await db.execute(sql`SELECT id FROM categories WHERE id = ${src}`)) as unknown as Rows<unknown>;
    expect(gone.rows).toHaveLength(0);
  });

  it("group rename route SQL is user-scoped", async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    const a = await createTestUser();
    const b = await createTestUser();
    await createCategory({ userId: a, name: "Rent", type: "E" });
    await createCategory({ userId: b, name: "Rent", type: "E" });
    await db.execute(sql`UPDATE categories SET "group" = 'Home'`);
    const { POST } = await import("@/app/api/categories/groups/route");
    authedUser = a;
    const post = async (body: unknown) =>
      parseResponse(await POST(createMockRequest("http://localhost:3000/api/categories/groups", { method: "POST", body })));
    expect((await post({ from: "Home", to: "House", dryRun: true })).data).toMatchObject({ affected: 1, targetExists: false, updated: 0 });
    expect((await post({ from: "Home", to: "House" })).data).toMatchObject({ affected: 1, updated: 1 });
    const mine = (await db.execute(sql`SELECT "group" FROM categories WHERE user_id = ${a}`)) as unknown as Rows<{ group: string }>;
    expect(mine.rows[0].group).toBe("House");
    const other = (await db.execute(sql`SELECT "group" FROM categories WHERE user_id = ${b}`)) as unknown as Rows<{ group: string }>;
    expect(other.rows[0].group).toBe("Home");
  });

  it("activity journal: insert with OAuth client name, summary query, 90-day sweep", async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    const { logMcpActivity } = await import("@/lib/mcp/activity-log");
    const { sweepMcpActivityLog } = await import("@/lib/cron/sweep-mcp-activity-log");
    const userId = await createTestUser();
    await db.execute(sql`DELETE FROM mcp_activity_log`);
    await db.execute(sql`INSERT INTO oauth_clients (client_id, client_name, created_at) VALUES ('cid-1', 'Claude', now()::text) ON CONFLICT (client_id) DO NOTHING`);

    logMcpActivity(db, { userId, client: { kind: "oauth", clientId: "cid-1" }, tool: "manage_tags", op: "rename", isWrite: true, ok: true, errorCode: null, affectedCount: 3 });
    logMcpActivity(db, { userId, client: { kind: "oauth", clientId: "unknown-cid" }, tool: "get_net_worth", op: null, isWrite: false, ok: true, errorCode: null, affectedCount: null });
    logMcpActivity(db, { userId, client: { kind: "api_key" }, tool: "record_transaction", op: null, isWrite: true, ok: false, errorCode: "tool_error", affectedCount: null });
    for (let i = 0; i < 50; i++) {
      const r = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM mcp_activity_log`)) as unknown as Rows<{ c: number }>;
      if (r.rows[0].c === 3) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const rows = (await db.execute(sql`SELECT client, tool, is_write, ok, affected_count FROM mcp_activity_log ORDER BY id`)) as unknown as Rows<Record<string, unknown>>;
    expect(rows.rows.map((r) => r.client).sort()).toEqual(["API key", "Claude", "unknown-cid"]);

    const { GET } = await import("@/app/api/settings/ai-access/route");
    authedUser = userId;
    const { status, data } = await parseResponse(await GET(createMockRequest("http://localhost:3000/api/settings/ai-access")));
    expect(status).toBe(200);
    const body = data as { clients: Array<{ client: string; calls7d: number; writes7d: number }>; events: unknown[]; apiKey: { exists: boolean } };
    expect(body.clients).toHaveLength(3);
    expect(body.clients.find((c) => c.client === "Claude")).toMatchObject({ calls7d: 1, writes7d: 1 });
    expect(body.events).toHaveLength(3);
    expect(body.apiKey.exists).toBe(false);
    const writes = (await parseResponse(await GET(createMockRequest("http://localhost:3000/api/settings/ai-access?writesOnly=1")))).data as { events: unknown[] };
    expect(writes.events).toHaveLength(2);

    await db.execute(sql`UPDATE mcp_activity_log SET created_at = now() - interval '91 days' WHERE client = 'Claude'`);
    const swept = await sweepMcpActivityLog();
    expect(swept.deleted).toBe(1);
  });
});
