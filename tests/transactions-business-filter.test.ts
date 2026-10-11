/**
 * GET /api/transactions `business` scope — the SQL side. The route passes
 * `business` into TxSortFilter; buildTxFilterConditions (shared by
 * getTransactions and getTransactionCount) turns it into the same condition
 * the reports use. DB-free: conditions are rendered with the PG dialect.
 */
import { describe, it, expect } from "vitest";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildTxFilterConditions } from "@/lib/queries";

const dialect = new PgDialect();
const render = (filters: Parameters<typeof buildTxFilterConditions>[1]) =>
  dialect.sqlToQuery(and(...buildTxFilterConditions("u1", filters))!).sql;

describe("buildTxFilterConditions business", () => {
  it("no business → no is_business condition", () => {
    expect(render({})).not.toContain("is_business");
    expect(render({ business: "all" })).not.toContain("is_business");
  });

  it("business → is_business = 1", () => {
    expect(render({ business: "business" })).toContain('"transactions"."is_business" = 1');
  });

  it("personal → NULL counts as personal", () => {
    expect(render({ business: "personal" })).toContain('COALESCE("transactions"."is_business", 0) = 0');
  });

  it("ANDs with the other SQL filters", () => {
    const q = render({ business: "business", startDate: "2026-01-01", amountMax: -500 });
    expect(q).toContain('"transactions"."date" >= $');
    expect(q).toContain('"transactions"."amount" <= $');
    expect(q).toContain('"transactions"."is_business" = 1');
  });
});
