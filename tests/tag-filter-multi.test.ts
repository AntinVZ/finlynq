/**
 * matchesTagFilter (lib/reports/tag-filter.ts): tags_all / tags_any /
 * tags_none / untagged, whole-tag normalized identity.
 */
import { describe, it, expect } from "vitest";
import {
  compileTagFilter,
  hasTagFilter,
  matchesTagFilter,
  parseTagFilter,
  tagFilterAcceptsUntagged,
} from "@/lib/reports/tag-filter";

const rows = {
  none: "",
  nul: null as string | null,
  work: "work",
  homework: "homework",
  workTravel: "Travel, WORK",
  ua: "Здоров’я,їжа",
};
const keep = (f: Parameters<typeof parseTagFilter>[0]) =>
  Object.entries(rows).filter(([, t]) => matchesTagFilter(t, parseTagFilter(f))).map(([k]) => k);

describe("parseTagFilter", () => {
  it("accepts comma lists and arrays, drops blanks", () => {
    expect(parseTagFilter({ tags_all: "a, b,,", tags_any: ["c", "d,e"], tags_none: " " })).toEqual({
      all: ["a", "b"],
      any: ["c", "d", "e"],
    });
  });

  it("untagged: true / \"true\" sets it; false / anything else does not", () => {
    expect(parseTagFilter({ untagged: true }).untagged).toBe(true);
    expect(parseTagFilter({ untagged: "TRUE" }).untagged).toBe(true);
    expect(parseTagFilter({ untagged: false })).toEqual({});
    expect(parseTagFilter({ untagged: "false" })).toEqual({});
    expect(parseTagFilter({ untagged: null })).toEqual({});
  });

  it("an empty filter matches everything and compiles to null", () => {
    const f = parseTagFilter({ tags_all: "", tags_any: [] });
    expect(hasTagFilter(f)).toBe(false);
    expect(compileTagFilter(f)).toBeNull();
    expect(keep({})).toEqual(Object.keys(rows));
  });
});

describe("matchesTagFilter", () => {
  it("tags_all needs every tag; whole tags only", () => {
    expect(keep({ tags_all: "work" })).toEqual(["work", "workTravel"]);
    expect(keep({ tags_all: ["work", "travel"] })).toEqual(["workTravel"]);
    expect(keep({ tags_all: "work,missing" })).toEqual([]);
  });

  it("tags_any needs one of them", () => {
    expect(keep({ tags_any: "homework,travel" })).toEqual(["homework", "workTravel"]);
  });

  it("tags_none excludes rows with any of them (untagged rows pass)", () => {
    expect(keep({ tags_none: "work" })).toEqual(["none", "nul", "homework", "ua"]);
  });

  it("untagged keeps only rows without tags", () => {
    expect(keep({ untagged: true })).toEqual(["none", "nul"]);
    expect(matchesTagFilter(" , ", { untagged: true })).toBe(true);
  });

  it("combinations are AND", () => {
    expect(keep({ tags_any: "work,homework", tags_none: "travel" })).toEqual(["work", "homework"]);
    expect(keep({ tags_all: "work", tags_any: "travel,x" })).toEqual(["workTravel"]);
    expect(keep({ untagged: true, tags_any: "work" })).toEqual([]);
    expect(keep({ untagged: true, tags_none: "work" })).toEqual(["none", "nul"]);
  });

  it("\"work\" never matches \"homework\"", () => {
    expect(matchesTagFilter("homework", { any: ["work"] })).toBe(false);
    expect(matchesTagFilter("homework", { none: ["work"] })).toBe(true);
  });

  it("Cyrillic and apostrophe variants are one tag", () => {
    expect(keep({ tags_all: "здоров'я, ЇЖА" })).toEqual(["ua"]);
    expect(keep({ tags_none: "ЗДОРОВ’Я" })).not.toContain("ua");
    expect(matchesTagFilter("Agrotrade", { any: ["agrotrade "] })).toBe(true);
  });
});

describe("tagFilterAcceptsUntagged", () => {
  it("is false only when all / any demand a tag", () => {
    expect(tagFilterAcceptsUntagged({})).toBe(true);
    expect(tagFilterAcceptsUntagged({ none: ["x"] })).toBe(true);
    expect(tagFilterAcceptsUntagged({ untagged: true })).toBe(true);
    expect(tagFilterAcceptsUntagged({ any: ["x"] })).toBe(false);
    expect(tagFilterAcceptsUntagged({ all: ["x"], none: ["y"] })).toBe(false);
  });
});
