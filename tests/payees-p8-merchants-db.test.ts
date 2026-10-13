/**
 * P8 stage 1 against a real Postgres: the Merchants search finds an entry
 * by name, alias, IBAN and a card's last 4 digits, answers "your account"
 * for an own requisite and refuses a full card number; the queue counts
 * decisions and is dropped on a directory change; the merchant page's
 * 12-month numbers. SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

const IBAN = "UA213223130000026007233566001";

describeDb("P8 Merchants search, queue and page numbers (seeded DB)", () => {
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
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_proposals, payee_merchant_types, payee_own_accounts RESTART IDENTITY CASCADE`);
    seed = await seedPayeeLedger();
    const { invalidatePayeeSuggest } = await import("@/lib/payees/suggest");
    invalidatePayeeSuggest(seed.userId);
  });

  const op = async (o: unknown) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, op: o as any, actor: "web" });
  };
  const search = async (q: string) => {
    const { db } = await import("@/db");
    const { searchMerchants } = await import("@/lib/payees/search");
    return searchMerchants({ executor: db, userId: seed.userId, dek: TEST_DEK, q });
  };
  const addTx = async (payee: string, date: string, amount: number) => {
    const { db } = await import("@/db");
    const { encryptField } = await import("@/lib/crypto/envelope");
    await db.execute(sql`
      INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source, import_hash)
      VALUES (${seed.userId}, ${date}, ${seed.accountId}, 'UAH', ${amount}, ${encryptField(TEST_DEK, payee)}, 'import', ${"p8m-" + Math.random()})`);
  };

  it("finds an entry by IBAN and by the last 4 card digits, masked", async () => {
    const r = await op({ op: "create", name: "Степаненко", type: "person", apply: false, identifiers: [{ kind: "iban", value: IBAN }, { kind: "card_last4", value: "1234" }] });
    const id = r.entity!.id;
    const byIban = await search(IBAN);
    expect(byIban.requisite).toMatchObject({ kind: "iban", strength: "strong" });
    expect(byIban.hits[0]).toMatchObject({ kind: "requisite", entityId: id, label: "Степаненко", detail: "UA21…6001" });
    const byCard = await search("1234");
    expect(byCard.requisite).toMatchObject({ kind: "card_last4", strength: "weak" });
    expect(byCard.hits.find((h) => h.kind === "requisite")?.entityId).toBe(id);
    const byMask = await search("5168 **** 1234");
    expect(byMask.hits.find((h) => h.kind === "requisite")?.entityId).toBe(id);
    expect(JSON.stringify(byIban)).not.toContain(IBAN);
  });

  it("finds by name and alias, says when a requisite is your own account, refuses a full card number", async () => {
    await op({ op: "create", name: "Епіцентр", apply: false, aliases: [{ pattern: "EPITCENTR K10", mode: "exact" }] });
    expect((await search("епіц")).hits[0]).toMatchObject({ kind: "entity", label: "Епіцентр" });
    expect((await search("EPITCENTR")).hits.some((h) => h.entityName === "Епіцентр")).toBe(true);
    await op({ op: "own_accounts", add: [{ iban: IBAN, bank: "mono", owner: "me" }] });
    expect((await search(IBAN)).own).toMatch(/mono/);
    const full = await search("5168 7573 1234 5678");
    expect(full.refusal).toBeTruthy();
    expect(full.hits).toEqual([]);
  });

  it("counts decisions in the queue and drops the cache on a directory change", async () => {
    const { db } = await import("@/db");
    const { loadQueueCounts } = await import("@/lib/payees/queue");
    const before = await loadQueueCounts({ executor: db, userId: seed.userId, dek: TEST_DEK });
    expect(before.decisions).toBe(before.clusters + before.lookalikes + before.drafts + before.suspicious);
    expect(before.unrecognized).toBeGreaterThan(0);
    await op({ op: "create", name: "Ma", apply: false });
    const after = await loadQueueCounts({ executor: db, userId: seed.userId, dek: TEST_DEK });
    expect(after.suspicious).toBe(before.suspicious + 1);
  });

  it("the merchant page: 12-month sum, count, average, last date, months and recent rows", async () => {
    await addTx("Rozetka", "2026-09-10", -300);
    await addTx("ROZETKA", "2026-08-10", -100);
    await addTx("Rozetka", "2024-01-10", -999);
    const r = await op({ op: "create", name: "Rozetka", apply: false });
    const { db } = await import("@/db");
    const { loadPayeeOverview } = await import("@/lib/payees/service");
    const { loadMerchantKpis } = await import("@/lib/payees/merchant-profile");
    const { loadPayeeNameMaps } = await import("@/lib/payees/scan");
    const overview = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK });
    const keys = new Set(overview.groups.filter((g) => g.entityId === r.entity!.id).map((g) => g.key));
    const k = await loadMerchantKpis({
      executor: db, userId: seed.userId, dek: TEST_DEK, keys, currency: "UAH", today: "2026-10-12",
      convert: (slices) => slices.reduce((n, s) => n + s.totalAmount, 0),
      names: await loadPayeeNameMaps(db, seed.userId, TEST_DEK),
    });
    expect(k).toMatchObject({ total: -400, spend: 400, count: 2, average: 200, lastDate: "2026-09-10" });
    expect(k.months).toHaveLength(12);
    expect(k.months.at(-1)).toEqual({ month: "2026-10", total: 0 });
    expect(k.months.find((m) => m.month === "2026-09")?.total).toBe(-300);
    expect(k.recent.map((x) => x.date)).toEqual(["2026-09-10", "2026-08-10", "2024-01-10"]);
  });
});
