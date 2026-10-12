/**
 * Payee Studio P5d merchant analyses against a real Postgres (rate map fixed
 * in the test, so no FX lookups). SKIPS unless DATABASE_URL names a `*_test`
 * database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { bootstrapTestDb, createAccount, createTestUser, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { encryptField } from "@/lib/crypto/envelope";
import { decomposeChange, histogram, quantile, regularity } from "@/lib/payees/merchant-analytics";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describe("merchant analytics helpers (pure)", () => {
  it("count + receipt effects add up to the total change", () => {
    const d = decomposeChange(2, 200, 4, 600);
    expect(d).toMatchObject({ avg1: 100, avg2: 150, countEffect: 200, receiptEffect: 200, total: 400 });
    const e = decomposeChange(5, 1000, 3, 900);
    expect(e.countEffect + e.receiptEffect).toBeCloseTo(e.total, 9);
  });
  it("quantiles, histogram and regularity", () => {
    expect(quantile([100, 100, 150, 150, 150, 150], 0.5)).toBe(150);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    const h = histogram([10, 20, 95]);
    expect(h.reduce((n, b) => n + b.count, 0)).toBe(3);
    expect(h.at(-1)!.to).toBe(100);
    expect(regularity(["2026-01-05", "2026-02-05", "2026-03-06", "2026-04-05"])).toMatchObject({ intervalDays: 30 });
    expect(regularity(["2026-01-01", "2026-01-03", "2026-03-30"])).toBeNull();
  });
});

describeDb("Payee Studio P5d merchant analyses (seeded DB)", () => {
  let userId = "";
  beforeAll(async () => {
    await bootstrapTestDb();
    await resetTestDb();
    const { db } = await import("@/db");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_rejections, payee_proposals RESTART IDENTITY CASCADE`);
    userId = await createTestUser();
    const uah = await createAccount({ userId, name: "Mono UAH", currency: "UAH", type: "A", isInvestment: false });
    const usd = await createAccount({ userId, name: "Wise USD", currency: "USD", type: "A", isInvestment: false });
    const cats = new Map<string, number>();
    for (const c of ["Home", "Garden"]) {
      const r = (await db.execute(sql`INSERT INTO categories (user_id, type, "group", name_ct) VALUES (${userId}, 'E', 'Home', ${encryptField(TEST_DEK, c)}) RETURNING id`)) as unknown as { rows: Array<{ id: number }> };
      cats.set(c, Number(r.rows[0].id));
    }
    const tx = async (payee: string, date: string, amount: number, o: { account?: number; currency?: string; reporting?: number | null; category?: string; business?: boolean; tags?: string } = {}) => {
      await db.execute(sql`
        INSERT INTO transactions (user_id, date, account_id, currency, amount, reporting_amount, reporting_currency, category_id, is_business, payee, tags, source, import_hash)
        VALUES (${userId}, ${date}, ${o.account ?? uah}, ${o.currency ?? "UAH"}, ${amount}, ${o.reporting ?? null}, ${o.reporting != null ? "UAH" : null},
                ${o.category ? cats.get(o.category)! : null}, ${o.business ? 1 : 0}, ${encryptField(TEST_DEK, payee)}, ${o.tags ? encryptField(TEST_DEK, o.tags) : ""}, 'manual', ${"h-" + randomUUID()})`);
    };
    // Netflix: monthly Jan–Jun 2026, silent since → quiet + regular.
    for (const m of ["01", "02", "03", "04", "05", "06"]) await tx("Netflix", `2026-${m}-05`, -300);
    // Сільпо: 2 × 100 in June, 4 × 150 in September (one of them in USD → converted at 40).
    await tx("Сільпо", "2026-06-03", -100);
    await tx("SILPO", "2026-06-20", -100);
    for (const d of ["02", "09", "16"]) await tx("Сільпо", `2026-09-${d}`, -150);
    await tx("Сільпо", "2026-09-23", -3.75, { account: usd, currency: "USD" });
    await tx("New Cafe", "2026-10-02", -80);
    for (const m of ["01", "02", "03"]) await tx("Old Shop", `2025-${m}-10`, -50);
    await tx("Back Gym", "2026-01-10", -500);
    await tx("Back Gym", "2026-02-10", -500);
    await tx("Back Gym", "2026-10-01", -500);
    // Епіцентр: 6 Home + 4 Garden; 3 of them business.
    for (let i = 0; i < 10; i++) await tx("Епіцентр", `2026-07-${String(i + 1).padStart(2, "0")}`, -200, { category: i < 6 ? "Home" : "Garden", business: i < 3, reporting: -200 });
    // A person: paid with a purpose in the payee, a tag purpose, and money back.
    await tx("Степаненко компенсація житла", "2026-08-15", -2000);
    await tx("Степаненко компенсація житла", "2026-09-15", -2000);
    await tx("Степаненко", "2026-09-20", -700, { tags: "оренда" });
    await tx("Степаненко", "2026-09-25", 500);
    const { executePayeeOp } = await import("@/lib/payees/ops");
    await executePayeeOp({ executor: db, userId, dek: TEST_DEK, actor: "web", op: { op: "create", name: "Степаненко", type: "person", aliases: [{ pattern: "Степаненко", mode: "contains" }], apply: false } });
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });

  const run = async (o: Record<string, unknown> = {}) => {
    const { db } = await import("@/db");
    const { computeMerchantAnalytics } = await import("@/lib/payees/merchant-analytics");
    const { buildPayeeMatcher, loadDirectory } = await import("@/lib/payees/directory");
    const { loadPayeeNameMaps } = await import("@/lib/payees/scan");
    return computeMerchantAnalytics({
      executor: db,
      userId,
      dek: TEST_DEK,
      matcher: buildPayeeMatcher(await loadDirectory(db, userId, TEST_DEK)),
      currency: "UAH",
      rateMap: new Map([["UAH", 1], ["USD", 40]]),
      asOf: "2026-10-12",
      categoryNames: (await loadPayeeNameMaps(db, userId, TEST_DEK)).categories,
      batchSize: 7,
      ...o,
    });
  };

  it("computes the eight analyses in the display currency", async () => {
    const a = await run();
    expect(a.truncated).toBe(false);
    expect(a.currency).toBe("UAH");
    // 1. receipt — SILPO and Сільпо are one payee; the USD row is converted (3.75 × 40 = 150), never added as 3.75.
    const silpo = a.receipt.find((r) => r.name === "Сільпо")!;
    expect(silpo).toMatchObject({ payments: 6, median: 150, max: 150, average: 133.33 });
    // 3. change: default periods May–Jul vs Aug–Oct 12.
    expect(a.change.period1).toEqual({ from: "2026-05-01", to: "2026-07-31" });
    expect(a.change.period2).toEqual({ from: "2026-08-01", to: "2026-10-12" });
    const ch = a.change.rows.find((r) => r.name === "Сільпо")!;
    expect(ch).toMatchObject({ n1: 2, n2: 4, spend1: 200, spend2: 600, countEffect: 200, receiptEffect: 200, total: 400 });
    expect(ch.countEffect + ch.receiptEffect).toBeCloseTo(ch.total, 2);
    expect(a.change.totals.countEffect + a.change.totals.receiptEffect).toBeCloseTo(a.change.totals.total, 1);
    // 4. lifecycle
    expect(a.lifecycle.quiet.map((r) => r.name)).toContain("Netflix");
    expect(a.lifecycle.new.map((r) => r.name)).toContain("New Cafe");
    expect(a.lifecycle.returned.find((r) => r.name === "Back Gym")).toMatchObject({ silentMonths: 6 });
    expect(a.lifecycle.churned.map((r) => r.name)).toContain("Old Shop");
    // 5. regular
    const nf = a.regular.find((r) => r.name === "Netflix")!;
    expect(nf.average).toBe(300);
    expect(nf.yearlyCost).toBe(Math.round((300 * 365) / nf.intervalDays * 100) / 100);
    expect(nf.nextExpected > "2026-06-05").toBe(true);
    // 6. several categories
    expect(a.multiCategory.find((r) => r.name === "Епіцентр")!.categories.map((c) => [c.name, c.share])).toEqual([["Home", 0.6], ["Garden", 0.4]]);
    // 7. business + personal
    expect(a.businessPersonal.find((r) => r.name === "Епіцентр")).toMatchObject({ business: 3, personal: 7, businessShare: 0.3 });
    // 8. people
    const p = a.people.find((r) => r.name === "Степаненко")!;
    expect(p).toMatchObject({ paid: 4700, received: 500, net: -4200 });
    expect(p.byPurpose.map((x) => [x.purpose, x.paid, x.received])).toEqual([
      ["компенсація житла", 4000, 0],
      ["оренда", 700, 0],
      ["(no purpose)", 0, 500],
    ]);
    // Nobody but people in the people list.
    expect(a.people.every((x) => x.name === "Степаненко")).toBe(true);
  });

  it("filters by period and by one counterparty; reports truncation", async () => {
    const one = await run({ name: "silpo" });
    expect(one.receipt.map((r) => r.name)).toEqual(["Сільпо"]);
    const sep = await run({ period: { from: "2026-09-01", to: "2026-09-30" }, name: "Сільпо" });
    expect(sep.receipt[0]).toMatchObject({ payments: 4, average: 150 });
    const cut = await run({ maxRows: 10 });
    expect(cut.truncated).toBe(true);
    expect(cut.scanned).toBe(10);
  });

  it("MCP op=insights with name returns the analyses of that payee only", async () => {
    const { mcpTool } = await import("./helpers/payee-mcp");
    const call = await mcpTool(userId, TEST_DEK);
    const res = await call({ op: "insights", name: "Netflix" });
    expect(res.merchants.counterparties).toBe(1);
    expect(res.merchants.regular[0]).toMatchObject({ name: "Netflix", average: 300 });
    expect(res.topBySpend).toBeUndefined();
  }, 30_000);
});
