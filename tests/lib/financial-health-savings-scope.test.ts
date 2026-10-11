/**
 * Dashboard Business / Personal view: `savingsScope` narrows ONLY the headline
 * savingsRatePct. The composite score (and its Savings Rate component) stays
 * whole-picture. DB-free: the fake db renders each query with the PG dialect.
 */
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/fx-service", () => ({ getRate: async () => 1 }));
vi.mock("@/lib/age-of-money", () => ({
  calculateAgeOfMoney: async () => ({ ageInDays: 0, trend: 0, history: [] }),
}));
vi.mock("@/lib/holdings-value", () => ({
  getHoldingsValueByAccount: async () => new Map(),
  verifyHoldingDecryptHealth: async () => ({ failed: 0, total: 0 }),
}));

import { calculateFinancialHealth } from "@/lib/financial-health";

const dialect = new PgDialect();
const month = new Date().toISOString().slice(0, 7);

function fakeDb() {
  const seen: string[] = [];
  return {
    seen,
    execute: vi.fn(async (q: SQL) => {
      const text = dialect.sqlToQuery(q).sql;
      seen.push(text);
      if (!text.includes("TO_CHAR(t.date::date, 'YYYY-MM') AS month")) return { rows: [] };
      if (text.includes("t.is_business = 1")) {
        // business: 1000 in, 900 out → 10%
        return { rows: [
          { month, cat_type: "I", currency: "CAD", total: 1000 },
          { month, cat_type: "E", currency: "CAD", total: -900 },
        ] };
      }
      if (text.includes("COALESCE(t.is_business, 0) = 0")) {
        return { rows: [
          { month, cat_type: "I", currency: "CAD", total: 4000 },
          { month, cat_type: "E", currency: "CAD", total: -1000 },
        ] };
      }
      // all: 5000 in, 1900 out → 62%
      return { rows: [
        { month, cat_type: "I", currency: "CAD", total: 5000 },
        { month, cat_type: "E", currency: "CAD", total: -1900 },
      ] };
    }),
  };
}

const run = (db: ReturnType<typeof fakeDb>, savingsScope?: "all" | "business" | "personal") =>
  calculateFinancialHealth({ db, userId: "u1", dek: null, reportingCurrency: "CAD", savingsScope });

describe("calculateFinancialHealth savingsScope", () => {
  it("default is whole-picture and adds no is_business condition", async () => {
    const db = fakeDb();
    const p = await run(db);
    expect(p.savingsRatePct).toBe(62);
    expect(p.savingsRateScope).toBe("all");
    expect(db.seen.some((s) => s.includes("is_business"))).toBe(false);
  });

  it("business scopes the headline only; the score's component is unchanged", async () => {
    const all = await run(fakeDb());
    const db = fakeDb();
    const p = await run(db, "business");
    expect(p.savingsRatePct).toBe(10);
    expect(p.savingsRateScope).toBe("business");
    expect(p.score).toBe(all.score);
    expect(p.components.find((c) => c.name === "Savings Rate")?.detail).toBe("62% savings rate");
  });

  it("personal uses the NULL-as-personal condition", async () => {
    const p = await run(fakeDb(), "personal");
    expect(p.savingsRatePct).toBe(75);
    expect(p.savingsRateScope).toBe("personal");
  });
});
