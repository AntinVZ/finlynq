/**
 * Business / personal / all scoping for the Reports endpoints and the MCP
 * cash-flow reads, plus the exact-tag predicate the MCP reads use.
 *
 * The compatibility rule is the load-bearing one: before the three-state
 * filter, `business=true` meant business-only and anything else meant every
 * row. Both of those readings must survive; only `false` is new.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  parseBusinessParam,
  serializeBusinessFilter,
  BUSINESS_PARAM,
  type BusinessFilter,
} from "@/lib/reports/business-filter";
import { businessFilterCondition } from "@/lib/reports/business-filter-sql";
import { hasExactTag } from "@/lib/reports/tag-filter";
import * as schema from "@/db/schema-pg";

const dialect = new PgDialect();

describe("parseBusinessParam", () => {
  it("keeps the legacy reading of business=true", () => {
    expect(parseBusinessParam("true")).toBe("business");
  });

  it("reads business=false as personal", () => {
    expect(parseBusinessParam("false")).toBe("personal");
  });

  it("reads all, absent and blank as every row", () => {
    expect(parseBusinessParam("all")).toBe("all");
    expect(parseBusinessParam(null)).toBe("all");
    expect(parseBusinessParam(undefined)).toBe("all");
    expect(parseBusinessParam("")).toBe("all");
  });

  it("degrades unrecognised values to all rather than an empty report", () => {
    expect(parseBusinessParam("yes")).toBe("all");
    expect(parseBusinessParam("1")).toBe("all");
  });

  it("tolerates case and whitespace", () => {
    expect(parseBusinessParam(" TRUE ")).toBe("business");
    expect(parseBusinessParam("False")).toBe("personal");
  });

  it("accepts real booleans (MCP clients send them)", () => {
    expect(parseBusinessParam(true)).toBe("business");
    expect(parseBusinessParam(false)).toBe("personal");
  });
});

describe("serializeBusinessFilter", () => {
  it("omits the param for all", () => {
    expect(serializeBusinessFilter("all")).toBeNull();
  });

  it("round-trips business and personal", () => {
    for (const f of ["business", "personal"] as BusinessFilter[]) {
      const wire = serializeBusinessFilter(f);
      expect(wire).not.toBeNull();
      expect(parseBusinessParam(wire)).toBe(f);
    }
  });

  it("uses the param name the routes read", () => {
    expect(BUSINESS_PARAM).toBe("business");
  });
});

describe("businessFilterCondition", () => {
  const render = (f: BusinessFilter) => {
    const cond = businessFilterCondition(f, schema.transactions.isBusiness);
    return cond ? dialect.sqlToQuery(cond).sql : null;
  };

  it("adds no condition for all", () => {
    expect(render("all")).toBeNull();
  });

  it("business = is_business = 1", () => {
    expect(render("business")).toBe('"transactions"."is_business" = 1');
  });

  it("personal treats NULL as not-business, so business + personal = all", () => {
    expect(render("personal")).toBe('COALESCE("transactions"."is_business", 0) = 0');
  });

  it("works on a raw column reference (MCP raw SQL)", () => {
    const cond = businessFilterCondition("personal", sql`t.is_business`);
    expect(dialect.sqlToQuery(cond!).sql).toBe("COALESCE(t.is_business, 0) = 0");
  });
});

describe("hasExactTag", () => {
  it("matches one tag among several", () => {
    expect(hasExactTag("travel,work, client-a", "work")).toBe(true);
    expect(hasExactTag("travel,work, client-a", "client-a")).toBe(true);
  });

  it("is case-insensitive and trims", () => {
    expect(hasExactTag("Work", " work ")).toBe(true);
  });

  it("never matches a substring", () => {
    expect(hasExactTag("homework", "work")).toBe(false);
    expect(hasExactTag("work-trip", "work")).toBe(false);
  });

  it("matches nothing for empty tags or a blank tag", () => {
    expect(hasExactTag(null, "work")).toBe(false);
    expect(hasExactTag("", "work")).toBe(false);
    expect(hasExactTag("work", "  ")).toBe(false);
  });
});
