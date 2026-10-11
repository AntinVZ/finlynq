/**
 * Home page Business / Personal scope — the SQL side, DB-free.
 *
 * Flow queries (income vs expenses, its category breakdown, spending by
 * category, monthly spending for insights, the weekly recap's flow figures)
 * take an optional `business` and AND the reports' condition into their WHERE.
 * Balance-side queries (account balances, net worth over time, the recap's
 * net-worth change) never do. A recording `db` captures every WHERE / JOIN and
 * renders it with the PG dialect.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

type Recorded = { from?: unknown; where: string[]; joins: string[] };
const rec = vi.hoisted(() => ({ queries: [] as Array<{ from?: unknown; where: unknown[]; joins: unknown[] }> }));

vi.mock("@/db", async () => {
  const schema = await import("@/db/schema-pg");
  const chain = () => {
    const q = { from: undefined as unknown, where: [] as unknown[], joins: [] as unknown[] };
    rec.queries.push(q);
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of ["groupBy", "orderBy", "limit", "offset", "innerJoin"]) c[m] = self;
    c.from = (t: unknown) => { q.from = t; return c; };
    c.where = (w: unknown) => { q.where.push(w); return c; };
    c.leftJoin = (_t: unknown, on: unknown) => { q.joins.push(on); return c; };
    c.all = async () => [];
    c.then = (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res);
    return c;
  };
  return { db: { select: () => chain(), execute: async () => ({ rows: [] }) }, schema, getDialect: () => "postgres" };
});
vi.mock("@/lib/fx-service", () => ({
  getDisplayCurrency: async () => "CAD",
  getRateMap: async () => new Map([["CAD", 1]]),
  convertWithRateMap: (n: number) => n,
}));
vi.mock("@/lib/subscriptions/advance-next-dates", () => ({ advanceStaleSubscriptionDatesSafe: async () => {} }));

import { schema } from "@/db";
import {
  getIncomeVsExpenses,
  getIncomeExpenseByCategory,
  getSpendingByCategoryWithReporting,
  getMonthlySpending,
  getNetWorthOverTime,
} from "@/lib/queries";
import { generateWeeklyRecap } from "@/lib/weekly-recap";

const dialect = new PgDialect();
const render = (s: unknown) => (s ? dialect.sqlToQuery(s as SQL).sql : "");
const queries = (): Recorded[] =>
  rec.queries.map((q) => ({ from: q.from, where: q.where.map(render), joins: q.joins.map(render) }));
const lastWhere = () => queries().at(-1)!.where.join(" ");

const BIZ = '"transactions"."is_business" = 1';
const PERSONAL = 'COALESCE("transactions"."is_business", 0) = 0';

beforeEach(() => {
  rec.queries.length = 0;
});

describe.each([
  ["getIncomeVsExpenses", getIncomeVsExpenses],
  ["getIncomeExpenseByCategory", getIncomeExpenseByCategory],
  ["getSpendingByCategoryWithReporting", getSpendingByCategoryWithReporting],
  ["getMonthlySpending", getMonthlySpending],
] as const)("%s", (_name, fn) => {
  it("default / all → no is_business condition", async () => {
    await fn("u1", "2026-01-01", "2026-12-31");
    expect(lastWhere()).not.toContain("is_business");
    await fn("u1", "2026-01-01", "2026-12-31", "all");
    expect(lastWhere()).not.toContain("is_business");
  });
  it("business → is_business = 1, still user-scoped", async () => {
    await fn("u1", "2026-01-01", "2026-12-31", "business");
    expect(lastWhere()).toContain(BIZ);
    expect(lastWhere()).toContain('"transactions"."user_id" = $1');
  });
  it("personal → NULL counts as personal", async () => {
    await fn("u1", "2026-01-01", "2026-12-31", "personal");
    expect(lastWhere()).toContain(PERSONAL);
  });
});

describe("net worth over time is never scoped", () => {
  it("has no business parameter and no condition", async () => {
    await getNetWorthOverTime("u1");
    expect(lastWhere()).not.toContain("is_business");
  });
});

describe("generateWeeklyRecap business", () => {
  it("scopes spending, income, budget spent and notable rows; not net-worth change or bills", async () => {
    await generateWeeklyRecap("u1", "2026-10-11", null, "business");
    const qs = queries();
    const txQueries = qs.filter((q) => q.from === schema.transactions);
    // spending ×2 (this + previous week), income ×2, notable ×1, net-worth change ×1
    expect(txQueries).toHaveLength(6);
    const scoped = txQueries.filter((q) => q.where.join(" ").includes(BIZ));
    expect(scoped).toHaveLength(5);
    const unscoped = txQueries.filter((q) => !q.where.join(" ").includes("is_business"));
    expect(unscoped).toHaveLength(1); // net-worth change
    expect(unscoped[0].joins).toHaveLength(0);

    // Budgets: the scope sits in the JOIN so a budget with no matching rows still shows.
    const budgetQ = qs.find((q) => q.from === schema.budgets)!;
    expect(budgetQ.where.join(" ")).not.toContain("is_business");
    expect(budgetQ.joins.some((j) => j.includes(BIZ))).toBe(true);

    const subsQ = qs.find((q) => q.from === schema.subscriptions)!;
    expect(subsQ.where.join(" ")).not.toContain("is_business");
  });

  it("defaults to all: no condition anywhere", async () => {
    await generateWeeklyRecap("u1", "2026-10-11", null);
    for (const q of queries()) {
      expect([...q.where, ...q.joins].join(" ")).not.toContain("is_business");
    }
  });
});
