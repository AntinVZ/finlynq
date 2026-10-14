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
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_proposals, payee_merchant_types, payee_own_accounts, payee_pair_rejections RESTART IDENTITY CASCADE`);
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

  it("stage 4: «Recommended: X» resolves spellings through the directory; the require setting is OFF by default", async () => {
    await op({ op: "create", name: "Епіцентр", apply: false, aliases: [{ pattern: "EPITCENTR K10", mode: "exact" }] });
    const { db } = await import("@/db");
    const { recommendPayee, recommendPayees } = await import("@/lib/payees/resolve-hint");
    expect(await recommendPayee({ executor: db, userId: seed.userId, dek: TEST_DEK, payee: "EPITCENTR K10" })).toMatchObject({ kind: "match", name: "Епіцентр", same: false });
    expect(await recommendPayee({ executor: db, userId: seed.userId, dek: TEST_DEK, payee: "Епіцентр" })).toMatchObject({ kind: "match", same: true });
    const many = await recommendPayees({ executor: db, userId: seed.userId, dek: TEST_DEK, payees: ["EPITCENTR K10", "Бабуся"] });
    expect(Object.keys(many)).toEqual(["EPITCENTR K10"]);
    const { getPayeeSettings, savePayeeSettings } = await import("@/lib/payees/settings");
    expect((await getPayeeSettings(db, seed.userId)).requireDirectoryPayee).toBe(false);
    expect((await savePayeeSettings(db, seed.userId, { requireDirectoryPayee: true })).requireDirectoryPayee).toBe(true);
  });

  it("stage 10: merchant / merchant-type rule conditions, test_rule counts, the hit counter", async () => {
    const { db } = await import("@/db");
    const { createCategory } = await import("./helpers/portfolio-fixtures");
    const created = await op({ op: "create", name: "Епіцентр", apply: false, merchantType: { group: "Ремонт і будівництво", name: "Ремонт і будівництво" }, aliases: [{ pattern: "EPITCENTR K10", mode: "exact" }] });
    const entityId = created.entity!.id;
    const [{ merchant_type_id: typeId }] = (await db.execute(sql`SELECT merchant_type_id FROM payee_entities WHERE id = ${entityId}`) as unknown as { rows: Array<{ merchant_type_id: number }> }).rows;
    expect(typeId).toBeGreaterThan(0);
    await addTx("EPITCENTR K10", "2026-09-10", -300);
    const { testRuleConditions } = await import("@/lib/rules/test-rule");
    const byMerchant = await testRuleConditions({ executor: db, userId: seed.userId, dek: TEST_DEK, conditions: { all: [{ field: "merchant", op: "is", entityId }] } });
    expect(byMerchant.matchedCount).toBeGreaterThan(0);
    expect(byMerchant.uncategorizedCount).toBe(byMerchant.matchedCount);
    expect(byMerchant.matches.every((m) => /epi|епі/i.test(m.payee))).toBe(true);
    const byType = await testRuleConditions({ executor: db, userId: seed.userId, dek: TEST_DEK, conditions: { all: [{ field: "merchant_type", op: "is", typeId }] } });
    expect(byType.matchedCount).toBe(byMerchant.matchedCount);
    const notIt = await testRuleConditions({ executor: db, userId: seed.userId, dek: TEST_DEK, conditions: { all: [{ field: "merchant", op: "is_not", entityId }] } });
    // An unresolved payee matches neither `is` nor `is_not`.
    expect(notIt.matchedCount).toBe(0);

    // The hit counter.
    const cat = await createCategory({ userId: seed.userId, name: "Дім", type: "E" });
    const [{ id: ruleId }] = (await db.execute(sql`
      INSERT INTO transaction_rules (user_id, name, conditions, actions, created_at)
      VALUES (${seed.userId}, 'r', ${JSON.stringify({ all: [{ field: "merchant", op: "is", entityId }] })}::jsonb, ${JSON.stringify([{ kind: "set_category", categoryId: cat }])}::jsonb, '2026-10-13')
      RETURNING id`) as unknown as { rows: Array<{ id: number }> }).rows;
    const { recordRuleHits } = await import("@/lib/rules/merchant-context");
    await recordRuleHits(db, seed.userId, [ruleId, ruleId, ruleId]);
    const [hits] = (await db.execute(sql`SELECT hit_count, last_hit_at FROM transaction_rules WHERE id = ${ruleId}`) as unknown as { rows: Array<{ hit_count: number; last_hit_at: unknown }> }).rows;
    expect(hits.hit_count).toBe(3);
    expect(hits.last_hit_at).not.toBeNull();
  });

  it("stage 10: «default category to N uncategorized» — preview, commit, 30-day undo; signs that don't fit are left alone", async () => {
    const { db } = await import("@/db");
    const { createCategory } = await import("./helpers/portfolio-fixtures");
    const cat = await createCategory({ userId: seed.userId, name: "Дім", type: "E" });
    const created = await op({ op: "create", name: "Епіцентр", apply: false, defaultCategoryId: cat, aliases: [{ pattern: "EPITCENTR K10", mode: "exact" }] });
    const entityId = created.entity!.id;
    await addTx("EPITCENTR K10", "2026-09-10", -300);
    await addTx("EPITCENTR K10", "2026-09-11", 120);
    const { executePayeeOp } = await import("@/lib/payees/ops");
    const preview = await executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, op: { op: "apply_default_category", entityId }, actor: "web", dryRun: true });
    expect(preview.categorized).toMatchObject({ categoryId: cat, category: "Дім", skippedSign: 1 });
    const n = preview.categorized!.count;
    expect(n).toBeGreaterThan(0);
    const count = async () => Number(((await db.execute(sql`SELECT count(*)::int AS n FROM transactions WHERE user_id = ${seed.userId} AND category_id = ${cat}`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n);
    expect(await count()).toBe(0);
    const done = await op({ op: "apply_default_category", entityId });
    expect(done.batchId).not.toBeNull();
    expect(await count()).toBe(n);
    await op({ op: "undo", batchId: done.batchId });
    expect(await count()).toBe(0);
  });

  it("stage 10: import order requisite → exact alias → type → queue; channels and own transfers apart", async () => {
    const { db } = await import("@/db");
    const { encryptStaged } = await import("@/lib/crypto/staging-envelope");
    const { randomUUID } = await import("crypto");
    await op({ op: "create", name: "ТОВ Будмайстер", type: "company", apply: false, identifiers: [{ kind: "iban", value: IBAN }] });
    await op({ op: "own_accounts", add: [{ iban: "UA903052992990004149123456789", bank: "privat", owner: "me" }] });
    let i = 10;
    for (const p of [`Оплата за рахунком ${IBAN}`, "OTPC2C", "P24 777", "UA903052992990004149123456789", "Аптека Здоров'я", "NEW SHOP 1"]) {
      await db.execute(sql`
        INSERT INTO staged_transactions (id, staged_import_id, user_id, date, amount, currency, payee, row_index, import_hash, encryption_tier)
        VALUES (${randomUUID()}, ${seed.stagedImportId}, ${seed.userId}, '2026-10-02', -10, 'UAH', ${encryptStaged(p)}, ${i++}, ${"sh-" + randomUUID()}, 'service')`);
    }
    await op({ op: "create", name: "Епіцентр", apply: false, aliases: [{ pattern: "EPITCENTR K10 KYIV 360616", mode: "exact" }] });
    const { applyPayeeImportAssist } = await import("@/lib/payees/import-assist");
    const r = await applyPayeeImportAssist({ executor: db, userId: seed.userId, dek: TEST_DEK, stagedImportId: seed.stagedImportId, readOnly: true });
    expect(r.summary).toMatchObject({ byRequisite: 1, byAlias: 1, channels: 2, own: 1, hinted: 0 });
    expect(r.summary.toQueue).toBe(3);
    expect(r.summary.byType).toBeGreaterThanOrEqual(1);
    expect(r.batchIds).toEqual([]);
    // With the import hint ON the requisite row gets the entry's name; import_hash stays.
    const { savePayeeSettings } = await import("@/lib/payees/settings");
    await savePayeeSettings(db, seed.userId, { importHint: true });
    const before = (await db.execute(sql`SELECT import_hash FROM staged_transactions WHERE staged_import_id = ${seed.stagedImportId} ORDER BY row_index`) as unknown as { rows: Array<{ import_hash: string }> }).rows;
    const w = await applyPayeeImportAssist({ executor: db, userId: seed.userId, dek: TEST_DEK, stagedImportId: seed.stagedImportId });
    expect(w.hinted).toBe(2);
    const after = (await db.execute(sql`SELECT import_hash FROM staged_transactions WHERE staged_import_id = ${seed.stagedImportId} ORDER BY row_index`) as unknown as { rows: Array<{ import_hash: string }> }).rows;
    expect(after).toEqual(before);
  });

  it("stage 2: overview cards — coverage, uncovered top, new merchants, a large check, duplicates; channels stay out", async () => {
    const { db } = await import("@/db");
    await op({ op: "create", name: "Rozetka", apply: false, merchantType: { group: "Маркетплейси", name: "Маркетплейси" } });
    for (const d of ["2026-05-10", "2026-06-10", "2026-07-10", "2026-08-10"]) await addTx("Rozetka", d, -100);
    await addTx("Rozetka", "2026-09-20", -5000);
    await addTx("Rozetka", "2026-09-21", -100);
    await addTx("Rozetka", "2026-09-21", -100);
    await addTx("ZZ NEW SHOP", "2026-10-01", -700);
    await addTx("P24 777", "2026-10-02", -900);
    const { computeOverviewCards } = await import("@/lib/payees/overview-cards");
    const { matcherFor } = await import("@/lib/payees/resolve-hint");
    const { loadOwnMatcher } = await import("@/lib/payees/own-accounts");
    const cards = await computeOverviewCards({
      executor: db, userId: seed.userId, dek: TEST_DEK,
      matcher: await matcherFor({ executor: db, userId: seed.userId, dek: TEST_DEK }),
      own: await loadOwnMatcher(db, seed.userId, TEST_DEK),
      convert: (slices) => slices.reduce((n, sl) => n + sl.totalAmount, 0), currency: "UAH",
      period: "30d", today: "2026-10-12",
    });
    expect(cards.from).toBe("2026-09-13");
    expect(cards.coverage.rows).toBeGreaterThanOrEqual(4);
    expect(cards.coverage.covered).toBeGreaterThanOrEqual(3);
    expect(cards.coverage.pct).toBeGreaterThan(0);
    expect(cards.topUncovered.some((u) => u.name === "ZZ NEW SHOP")).toBe(true);
    expect(JSON.stringify(cards)).not.toContain("P24 777");
    expect(cards.largeChecks.find((l) => l.name === "Rozetka")).toMatchObject({ amount: -5000, date: "2026-09-20" });
    expect(cards.duplicates.items.some((d) => d.name === "Rozetka" && d.date === "2026-09-21")).toBe(true);
    expect(cards.newMerchants.some((m) => m.name === "Rozetka")).toBe(false);
  });

  it("stage 2: the merchant page insights and Reports by merchant type", async () => {
    const { merchantInsights } = await import("@/lib/payees/merchant-profile");
    const ins = merchantInsights([100, 100, 100, 100, 900], ["2026-05-10", "2026-06-10", "2026-07-10", "2026-08-10", "2026-09-10"]);
    expect(ins).toMatchObject({ cadence: "monthly", typicalLow: 100, typicalHigh: 100, largeCount: 1 });
    expect(ins!.nextExpected! > "2026-10-05").toBe(true);
    expect(merchantInsights([1, 2], ["2026-01-01", "2026-02-01"])).toBeNull();

    const { db } = await import("@/db");
    const { createCategory } = await import("./helpers/portfolio-fixtures");
    const cat = await createCategory({ userId: seed.userId, name: "Покупки", type: "E" });
    await op({ op: "create", name: "Rozetka", apply: false, merchantType: { group: "Маркетплейси", name: "Маркетплейси" } });
    await addTx("Rozetka", "2026-09-10", -300);
    await addTx("ZZ OTHER", "2026-09-11", -50);
    await db.execute(sql`UPDATE transactions SET category_id = ${cat} WHERE user_id = ${seed.userId} AND date IN ('2026-09-10', '2026-09-11')`);
    const { loadMerchantTypeRows } = await import("@/lib/reports/merchant-type-breakdown");
    const { matcherFor } = await import("@/lib/payees/resolve-hint");
    const { loadMerchantTypes } = await import("@/lib/payees/merchant-types");
    const out = await loadMerchantTypeRows({
      executor: db, userId: seed.userId, dek: TEST_DEK,
      matcher: await matcherFor({ executor: db, userId: seed.userId, dek: TEST_DEK }),
      types: await loadMerchantTypes(db, seed.userId),
      periodSql: sql`to_char(transactions.date::date, 'YYYY-MM')`,
      where: sql`transactions.user_id = ${seed.userId} AND transactions.date >= '2026-09-01' AND transactions.date <= '2026-09-30'`,
      label: (t) => t.group,
    });
    const typed = out.rows.find((r) => r.amount === -300);
    expect(typed).toMatchObject({ label: "Маркетплейси", categoryType: "E", period: "2026-09" });
    expect(typed!.typeId).toBeGreaterThan(0);
    expect(out.rows.find((r) => r.amount === -50)).toMatchObject({ label: null, typeId: null });
  });

  it("stage 9: review pack pages with a cursor and a compact form; payee_resolution for MCP writes", async () => {
    const { db } = await import("@/db");
    for (const p of ["ZZ SHOP ONE", "ZZ SHOP TWO", "ZZ SHOP THREE"]) await addTx(p, "2026-09-10", -10);
    const { loadPayeeOverview } = await import("@/lib/payees/service");
    const { buildReviewPack } = await import("@/lib/payees/proposals");
    const { decodeCursor } = await import("@/lib/payees/mcp-page");
    const o = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK });
    const first = buildReviewPack(o, [], { limit: 2, compact: true });
    expect(first.unrecognized).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBeTruthy();
    expect("directory" in first).toBe(false);
    expect(Object.keys(first.unrecognized[0]).sort()).toEqual(expect.arrayContaining(["count", "key", "payee", "total", "typeGuess"]));
    const seen = new Set(first.unrecognized.map((u) => u.key));
    let cursor = first.next_cursor;
    while (cursor) {
      const next = buildReviewPack(o, [], { limit: 2, compact: true, offset: decodeCursor(cursor) });
      expect(next.clusters).toEqual([]);
      for (const u of next.unrecognized) {
        expect(seen.has(u.key)).toBe(false);
        seen.add(u.key);
      }
      cursor = next.next_cursor;
    }
    expect(seen.size).toBe(first.total);

    await op({ op: "create", name: "Епіцентр", apply: false, aliases: [{ pattern: "EPITCENTR K10", mode: "exact" }] });
    const { invalidatePayeeSuggest } = await import("@/lib/payees/suggest");
    invalidatePayeeSuggest(seed.userId);
    const { resolvePayeeForMcp } = await import("@/lib/payees/payee-resolution");
    expect(await resolvePayeeForMcp({ executor: db, userId: seed.userId, dek: TEST_DEK, payee: "EPITCENTR K10", storedAs: "EPITCENTR K10" })).toMatchObject({ status: "matched", name: "Епіцентр", renamed: false });
    expect(await resolvePayeeForMcp({ executor: db, userId: seed.userId, dek: TEST_DEK, payee: "Нова кав'ярня", storedAs: "Нова кав'ярня" })).toMatchObject({ status: "not_in_directory" });
    expect(await resolvePayeeForMcp({ executor: db, userId: seed.userId, dek: TEST_DEK, payee: "P24", storedAs: "P24" })).toMatchObject({ status: "channel" });
    expect(await resolvePayeeForMcp({ executor: db, userId: seed.userId, dek: null, payee: "X", storedAs: "X" })).toMatchObject({ status: "unavailable" });
    expect(await resolvePayeeForMcp({ executor: db, userId: seed.userId, dek: TEST_DEK, payee: "  ", storedAs: "" })).toBeNull();
  });

  it("stage 11: duplicates by amount, people without an entry, «needs check» reasons, fees", async () => {
    const { db } = await import("@/db");
    for (const d of ["2026-07-05", "2026-08-05", "2026-09-05"]) {
      await addTx("Степаненко", d, -15000);
      await addTx("Stepanenko O.", d, -15000);
    }
    await addTx("Іваненко Петро Олегович", "2026-09-01", -500);
    const { findAmountDuplicates, rejectAmountPair } = await import("@/lib/payees/amount-duplicates");
    const { matcherFor } = await import("@/lib/payees/resolve-hint");
    const { loadOwnMatcher } = await import("@/lib/payees/own-accounts");
    const ctx = async () => ({ executor: db, userId: seed.userId, dek: TEST_DEK, matcher: await matcherFor({ executor: db, userId: seed.userId, dek: TEST_DEK }), own: await loadOwnMatcher(db, seed.userId, TEST_DEK) });
    const found = await findAmountDuplicates(await ctx());
    const pair = found.pairs.find((p) => [p.a.name, p.b.name].sort().join("|") === "Stepanenko O.|Степаненко");
    expect(pair).toMatchObject({ shared: 3 });
    expect(pair!.matches[0]).toMatchObject({ date: "2026-09-05", amount: -15000 });
    expect(await rejectAmountPair(db, seed.userId, TEST_DEK, pair!.id)).toBe(true);
    expect((await findAmountDuplicates(await ctx())).pairs.some((p) => p.id === pair!.id)).toBe(false);
    const [stored] = (await db.execute(sql`SELECT pair_hash FROM payee_pair_rejections WHERE user_id = ${seed.userId}`) as unknown as { rows: Array<{ pair_hash: string }> }).rows;
    expect(stored.pair_hash).not.toMatch(/stepan|степан/i);
    await rejectAmountPair(db, seed.userId, TEST_DEK, pair!.id, true);
    expect((await findAmountDuplicates(await ctx())).pairs.some((p) => p.id === pair!.id)).toBe(true);
    expect(await rejectAmountPair(db, seed.userId, TEST_DEK, "bogus")).toBe(false);

    const { computeOverviewCards } = await import("@/lib/payees/overview-cards");
    const cards = await computeOverviewCards({ ...(await ctx()), convert: (sl) => sl.reduce((n, x) => n + x.totalAmount, 0), currency: "UAH", period: "90d", today: "2026-10-12" });
    expect(cards.needEntities.some((p) => p.name === "Іваненко Петро Олегович")).toBe(true);
    expect(cards.needEntities.every((p) => p.name !== "Rozetka")).toBe(true);

    // «Needs check»: a requisite that is your own account.
    const own = "UA903052992990004149123456789";
    await op({ op: "own_accounts", add: [{ iban: own, bank: "privat", owner: "me" }] });
    await op({ op: "create", name: "Переказ собі", apply: false, identifiers: [{ kind: "iban", value: own }] });
    const { loadPayeeOverview, suspiciousOf } = await import("@/lib/payees/service");
    const o = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK });
    const flagged = suspiciousOf(o).find((x) => x.name === "Переказ собі");
    expect(flagged?.reasons.map((r) => r.code)).toContain("own_requisite");

    // Fees apart.
    const { isFeeRow } = await import("@/lib/payees/merchant-profile");
    expect(isFeeRow("Комісія за переказ Степаненко", null)).toBe(true);
    expect(isFeeRow("Степаненко", "Bank fees")).toBe(true);
    expect(isFeeRow("Feedback Ltd", null)).toBe(false);
  });

  it("stage 11: «Колеги» is its own people group, never ФОП", async () => {
    const { db } = await import("@/db");
    const { payeeTypeForMerchantType, isPersonsMerchantGroup, isColleaguesMerchantGroup } = await import("@/lib/payees/payee-type");
    expect(payeeTypeForMerchantType("Колеги", "sole_proprietor")).toBe("person");
    expect(isPersonsMerchantGroup(null, "colleagues")).toBe(true);
    expect(isColleaguesMerchantGroup("Особи і ФОП", "persons")).toBe(false);
    const { defaultMerchantTypes, loadMerchantTypes } = await import("@/lib/payees/merchant-types");
    expect(defaultMerchantTypes().some((t) => t.code === "colleagues" && t.group === "Колеги")).toBe(true);
    const r = await op({ op: "create", name: "Олена Коваль", apply: false, merchantType: { group: "Колеги", name: "Колеги" } });
    const [row] = (await db.execute(sql`SELECT type FROM payee_entities WHERE id = ${r.entity!.id}`) as unknown as { rows: Array<{ type: string }> }).rows;
    expect(row.type).toBe("person");
    expect((await loadMerchantTypes(db, seed.userId)).some((t) => t.code === "colleagues")).toBe(true);
  });
});
