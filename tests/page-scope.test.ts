/**
 * Reports / Transactions scope: the page follows the global view scope, may
 * override it locally, and the list request carries `business=` only when the
 * scope isn't All.
 */
import { describe, it, expect } from "vitest";
import { resolvePageScope } from "@/components/page-scope";
import { buildTransactionQuery, type TxFilters } from "@/lib/transactions/build-query";

describe("resolvePageScope", () => {
  it("personal usage mode: always all, never overridden", () => {
    expect(resolvePageScope(false, "business", "personal")).toEqual({ scope: "all", overridden: false });
  });
  it("no override: follows the global scope", () => {
    expect(resolvePageScope(true, "business", null)).toEqual({ scope: "business", overridden: false });
  });
  it("override wins and is flagged", () => {
    expect(resolvePageScope(true, "business", "personal")).toEqual({ scope: "personal", overridden: true });
  });
  it("an override equal to the global scope is not an override", () => {
    expect(resolvePageScope(true, "all", "all")).toEqual({ scope: "all", overridden: false });
  });
});

describe("buildTransactionQuery business", () => {
  const base: TxFilters = { startDate: "2026-01-01" };
  const qs = (business?: TxFilters["business"]) =>
    buildTransactionQuery({ ...base, business }, { columnId: null, direction: null }, [], [], { page: 0, limit: 50 }).toString();

  it("absent or all → no param (URL unchanged)", () => {
    expect(qs()).toBe("startDate=2026-01-01&limit=50&offset=0");
    expect(qs("all")).toBe(qs());
  });
  it("business → business=true, personal → business=false", () => {
    expect(qs("business")).toContain("business=true");
    expect(qs("personal")).toContain("business=false");
  });
});
