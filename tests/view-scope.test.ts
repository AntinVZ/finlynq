/**
 * Usage mode + view scope rules (lib/view-scope.ts): strict parsing for the
 * settings API, defaults for missing rows, and personal mode forcing "all".
 */
import { describe, it, expect } from "vitest";
import {
  parseUsageMode,
  parseViewScope,
  usageModeFromStored,
  viewScopeFromStored,
  effectiveScope,
} from "@/lib/view-scope";
import { serializeBusinessFilter } from "@/lib/reports/business-filter";

describe("parseUsageMode / parseViewScope (strict)", () => {
  it.each(["personal", "business_too"])("accepts %s", (v) => {
    expect(parseUsageMode(v)).toBe(v);
  });
  it.each(["", "business", "Personal", null, undefined, true, 1])("rejects %j", (v) => {
    expect(parseUsageMode(v)).toBeNull();
  });
  it.each(["all", "business", "personal"])("scope accepts %s", (v) => {
    expect(parseViewScope(v)).toBe(v);
  });
  it.each(["", "true", "false", "ALL", null, undefined, false])("scope rejects %j", (v) => {
    expect(parseViewScope(v)).toBeNull();
  });
});

describe("stored values", () => {
  it("missing or unknown rows read as the defaults", () => {
    expect(usageModeFromStored(null)).toBe("personal");
    expect(usageModeFromStored("garbage")).toBe("personal");
    expect(viewScopeFromStored(undefined)).toBe("all");
    expect(viewScopeFromStored("garbage")).toBe("all");
  });
});

describe("effectiveScope", () => {
  it("personal mode always shows everything", () => {
    expect(effectiveScope("personal", "business")).toBe("all");
    expect(effectiveScope("personal", "personal")).toBe("all");
  });
  it("business_too mode applies the stored scope", () => {
    expect(effectiveScope("business_too", "business")).toBe("business");
    expect(effectiveScope("business_too", "personal")).toBe("personal");
    expect(effectiveScope("business_too", "all")).toBe("all");
  });
  it("scopes go on the wire as the reports' business param", () => {
    expect(serializeBusinessFilter("business")).toBe("true");
    expect(serializeBusinessFilter("personal")).toBe("false");
    expect(serializeBusinessFilter("all")).toBeNull();
  });
});
