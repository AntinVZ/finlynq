/**
 * Payee Studio P6.2 stage 4 against a real Postgres: bulk registry fill —
 * 150 counterparties become 150 directory entries in ONE batch with one
 * preview; unticked rows stay out; undo removes everything; people and ФОП
 * never enter the set; spellings become exact aliases; a merchant type only
 * when confirmed; nothing is renamed until a separate Apply. Also MCP
 * bulk_review → bulk_create. SKIPS unless DATABASE_URL names a `*_test` db.
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

describeDb("Payee Studio P6.2 bulk registry (seeded DB)", () => {
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
  const types = async () => (await import("@/lib/payees/merchant-types")).loadMerchantTypes((await import("@/db")).db, seed.userId);
  const typeName = async (id: number | null) => (id == null ? null : ((await types()).find((t) => t.id === id)?.name ?? null));
  const tools = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-p6-2-bulk", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await t[name].handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };

  // Names that do not look alike (each its own 4-letter start), so clustering never joins them.
  const first = ["ka", "lo", "mi", "nu", "pe", "ra", "so", "ti", "du", "be", "fa", "go", "hu", "ve", "zo"];
  const second = ["ba", "de", "fi", "gu", "jo", "ke", "lu", "ma", "ni", "po"];
  const brand = (i: number) => {
    const w = `${first[i % first.length]}${second[Math.floor(i / first.length) % second.length]}ndor`;
    return w[0].toUpperCase() + w.slice(1);
  };
  const isMine = (name: string) => /^[A-Z][a-z]{3}ndor Store$/.test(name);
  /** n merchants, each under two spellings (Mixed case + ALL CAPS with terminal noise). */
  const seedMerchants = async (n: number) => {
    const { db } = await import("@/db");
    const { encryptField } = await import("@/lib/crypto/envelope");
    const values = [];
    for (let i = 0; i < n; i++) {
      for (const payee of [`${brand(i)} Store`, `${brand(i).toUpperCase()} STORE K12 KYIV`]) {
        values.push(sql`(${seed.userId}, '2026-09-10', ${seed.accountId}, 'UAH', -50, ${encryptField(TEST_DEK, payee)}, 'import', ${"bk-" + i + "-" + payee.length + "-" + Math.random()})`);
      }
    }
    await db.execute(sql`INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source, import_hash) VALUES ${sql.join(values, sql`, `)}`);
  };
  const candidates = async (threshold?: number) => {
    const { db } = await import("@/db");
    const { loadPayeeOverview } = await import("@/lib/payees/service");
    const { buildBulkCandidates } = await import("@/lib/payees/bulk-registry");
    const o = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK });
    return { o, c: buildBulkCandidates(o, { threshold }) };
  };
  const commit = async (items: unknown[], dryRun = false) => {
    const { db } = await import("@/db");
    const { commitBulkRegistry } = await import("@/lib/payees/bulk-registry");
    const { o } = await candidates();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return commitBulkRegistry({ executor: db, userId: seed.userId, dek: TEST_DEK, overview: o, items: items as any, actor: "web", dryRun });
  };

  it("150 counterparties: one preview, one batch, every spelling an exact alias, nothing renamed yet; undo removes all", async () => {
    await seedMerchants(150);
    const { c } = await candidates();
    const mine = c.rows.filter((r) => isMine(r.name));
    expect(mine).toHaveLength(150);
    expect(mine[0].spellings).toHaveLength(2);
    expect(isMine(mine[0].name)).toBe(true);
    const items = mine.map((r) => ({ rowId: r.rowId }));
    const preview = await commit(items, true);
    expect(preview.dryRun).toBe(true);
    expect(preview.bulk.created).toBe(150);
    expect(preview.bulk.pendingRows).toBe(150); // the ALL CAPS spelling of each gets renamed by a later Apply
    expect(await dir()).toHaveLength(0);

    const done = await commit(items);
    expect(done.batchId).toEqual(expect.any(Number));
    const d = await dir();
    expect(d).toHaveLength(150);
    const e = d.find((x) => x.name === `${brand(7)} Store`)!;
    expect(e.aliases.filter((a) => a.mode === "exact").map((a) => a.pattern).sort()).toEqual([`${brand(7)} Store`, `${brand(7).toUpperCase()} STORE K12 KYIV`].sort());
    expect(e.merchantTypeId).toBeNull();
    expect(done.rows.total).toBe(0); // no rename in the bulk step
    const { db } = await import("@/db");
    const batches = await (await import("@/lib/payees/batches")).listPayeeBatches(db, seed.userId, { limit: 5 });
    expect(batches.filter((b) => b.kind === "bulk_registry")).toHaveLength(1);

    await op({ op: "undo", batchId: done.batchId });
    expect(await dir()).toHaveLength(0);
  }, 60_000);

  it("unticked rows stay out; edited names and confirmed types are used", async () => {
    await seedMerchants(5);
    const { c } = await candidates();
    const rows = c.rows.filter((r) => isMine(r.name));
    const done = await commit([
      { rowId: rows[0].rowId, name: "Перший Бренд", merchantType: "Супермаркети і продукти" },
      { rowId: rows[1].rowId },
    ]);
    expect(done.bulk.created).toBe(2);
    const d = await dir();
    expect(d.map((e) => e.name).sort()).toEqual(["Перший Бренд", rows[1].name].sort());
    expect(await typeName(d.find((e) => e.name === "Перший Бренд")!.merchantTypeId)).toBe("Супермаркети і продукти");
    expect(d.find((e) => e.name === rows[1].name)!.merchantTypeId).toBeNull();
    // The created rows leave the candidate list.
    const after = (await candidates()).c.rows.map((r) => r.rowId);
    expect(after).not.toContain(rows[0].rowId);
    expect(after).toContain(rows[2].rowId);
  });

  it("people and ФОП are never in the table; they are listed apart and refused in a set", async () => {
    const { c } = await candidates();
    const names = c.rows.map((r) => r.name).join(" | ");
    expect(names).not.toMatch(/Деркач|DERKACH|DAVYDZON/i);
    expect(c.people.map((p) => p.name).join(" | ")).toMatch(/Деркач|DAVYDZON/i);
    await expect(commit([{ rowId: c.people[0].rowId }])).rejects.toThrow(/Особи/);
    await expect(commit([{ rowId: c.rows[0].rowId, name: "Іваненко Петро Васильович" }])).rejects.toThrow(/особу/);
  });

  it("the threshold and a too-big set", async () => {
    await seedMerchants(3);
    const strict = await candidates(0.99);
    const loose = await candidates(0.6);
    expect(loose.c.rows.length).toBeGreaterThanOrEqual(strict.c.rows.length);
    const { BULK_MAX } = await import("@/lib/payees/bulk-registry");
    const many = Array.from({ length: BULK_MAX + 1 }, (_, i) => ({ rowId: `g_${i}` }));
    await expect(commit(many)).rejects.toThrow(/Завеликий пакет/);
    await expect(commit([{ rowId: "g_gone" }])).rejects.toThrow(/Оновіть таблицю/);
  });

  it("MCP: bulk_review, then bulk_create two-step", async () => {
    await seedMerchants(4);
    const call = await tools();
    const review = await call("manage_payees", { op: "bulk_review" });
    const rows = review.rows.filter((r: { name: string }) => isMine(r.name));
    expect(rows).toHaveLength(4);
    expect(review.people.length).toBeGreaterThan(0);
    const args = { op: "bulk_create", items: rows.slice(0, 3).map((r: { row_id: string }) => ({ row_id: r.row_id })) };
    const p = await call("manage_payees", args);
    expect(p.preview).toBe(true);
    expect(p.bulk.created).toBe(3);
    const done = await call("manage_payees", { ...args, confirmation_token: p.confirmationToken });
    expect(done.error).toBeUndefined();
    expect(done.bulk.created).toBe(3);
    expect(await dir()).toHaveLength(3);
  });
});
