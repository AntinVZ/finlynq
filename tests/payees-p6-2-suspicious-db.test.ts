/**
 * Payee Studio P6.2 stage 2 against a real Postgres: the "Перевірити" list,
 * the "checked" mark (kept across other changes, undoable), deleting an
 * entry keeps its rows, and the MCP suspicious / mark_reviewed / delete ops.
 * SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("Payee Studio P6.2 suspicious entries (seeded DB)", () => {
  let seed: SeededPayees;
  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_proposals, payee_merchant_types RESTART IDENTITY CASCADE`);
    seed = await seedPayeeLedger();
  });

  const op = async (o: unknown, dryRun = false) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, op: o as any, actor: "web", dryRun });
  };
  const dir = async () => (await import("@/lib/payees/directory")).loadDirectory((await import("@/db")).db, seed.userId, TEST_DEK);
  const tools = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-p6-2-suspicious", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await t[name].handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };

  const addTx = async (payee: string, n = 1) => {
    const { db } = await import("@/db");
    const { encryptField } = await import("@/lib/crypto/envelope");
    for (let i = 0; i < n; i++) {
      await db.execute(sql`
        INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source, import_hash)
        VALUES (${seed.userId}, '2026-09-15', ${seed.accountId}, 'UAH', -100, ${encryptField(TEST_DEK, payee)}, 'import', ${"p62s-" + Math.random()})`);
    }
  };
  const suspicious = async (includeReviewed = false) => {
    const { db } = await import("@/db");
    const { loadPayeeOverview, suspiciousOf } = await import("@/lib/payees/service");
    return suspiciousOf(await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK }), { includeReviewed });
  };
  const seedOdd = async () => {
    await addTx("Ma", 3);
    await addTx("Galia baluvana", 1);
    const ma = await op({ op: "create", name: "Ma", apply: false });
    const galia = await op({ op: "create", name: "Galia baluvana", apply: false });
    await op({ op: "create", name: "Сільпо", apply: false });
    return { ma: ma.entity!.id as number, galia: galia.entity!.id as number };
  };

  it("lists short / meaningless entries with reasons, rows and spellings; nothing changes by itself", async () => {
    await seedOdd();
    const list = await suspicious();
    expect(list.map((x) => x.name)).toEqual(["Ma", "Galia baluvana"]);
    expect(list[0]).toMatchObject({ count: 3, spellings: [{ spelling: "Ma", count: 3 }] });
    expect(list[0].reasons[0].code).toBe("short");
    expect((await dir()).every((e) => e.reviewedAt == null)).toBe(true);
  });

  it("the checked mark keeps the entry out, survives a rename, and undo brings it back", async () => {
    const { ma } = await seedOdd();
    const preview = await op({ op: "mark_reviewed", entityIds: [ma] }, true);
    expect(preview.reviewed).toEqual([{ id: ma, name: "Ma", reviewed: true }]);
    expect((await suspicious()).map((x) => x.name)).toContain("Ma");
    const done = await op({ op: "mark_reviewed", entityIds: [ma] });
    expect(done.batchId).toEqual(expect.any(Number));
    expect((await suspicious()).map((x) => x.name)).toEqual(["Galia baluvana"]);
    // Another change to the entry keeps the mark.
    await op({ op: "update", entityId: ma, note: "family nickname", apply: false });
    expect((await dir()).find((e) => e.id === ma)!.reviewedAt).not.toBeNull();
    expect((await suspicious(true)).map((x) => x.name)).toContain("Ma");
    // Undo the newest first (the note), then the mark.
    const batches = (await import("@/lib/payees/batches")).listPayeeBatches;
    const { db } = await import("@/db");
    const [newest] = await batches(db, seed.userId, { limit: 1 });
    await op({ op: "undo", batchId: newest.id });
    await op({ op: "undo", batchId: done.batchId });
    expect((await suspicious()).map((x) => x.name)).toEqual(["Ma", "Galia baluvana"]);
  });

  it("deleting an entry keeps its transaction rows; undo restores the entry", async () => {
    const { galia } = await seedOdd();
    const { db } = await import("@/db");
    const before = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM transactions WHERE user_id = ${seed.userId}`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n);
    const del = await op({ op: "delete", entityId: galia });
    expect(del.rows.total).toBe(0);
    const after = Number(((await db.execute(sql`SELECT count(*)::int AS n FROM transactions WHERE user_id = ${seed.userId}`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n);
    expect(after).toBe(before);
    expect((await dir()).some((e) => e.id === galia)).toBe(false);
    await op({ op: "undo", batchId: del.batchId });
    expect((await dir()).some((e) => e.id === galia)).toBe(true);
  });

  it("MCP: suspicious, then mark_reviewed two-step", async () => {
    const { ma } = await seedOdd();
    const call = await tools();
    const list = await call("manage_payees", { op: "suspicious" });
    expect(list.entries.map((e: { name: string }) => e.name)).toEqual(["Ma", "Galia baluvana"]);
    expect(list.entries[0].reasons[0]).toContain("коротка");
    const p = await call("manage_payees", { op: "mark_reviewed", entity_ids: [ma] });
    expect(p.preview).toBe(true);
    expect((await suspicious()).length).toBe(2);
    const done = await call("manage_payees", { op: "mark_reviewed", entity_ids: [ma], confirmation_token: p.confirmationToken });
    expect(done.error).toBeUndefined();
    expect((await call("manage_payees", { op: "suspicious" })).entries.map((e: { name: string }) => e.name)).toEqual(["Galia baluvana"]);
  });
});
