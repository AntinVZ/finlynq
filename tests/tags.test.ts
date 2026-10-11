/**
 * lib/tags.ts — parse / format / add / remove / replace on the stored
 * comma-separated tag string. Identity is `normalizeForMatch`.
 */
import { describe, it, expect } from "vitest";
import { addTags, formatTags, parseTags, removeTags, replaceTags, toTagList, TAG_SEPARATOR } from "@/lib/tags";

describe("parseTags / formatTags", () => {
  it("splits on comma, trims, drops empties", () => {
    expect(parseTags(" travel , ,work,, ")).toEqual(["travel", "work"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags(" , ")).toEqual([]);
  });

  it("deduplicates by normalized identity, keeping the first spelling", () => {
    expect(parseTags("Acme,acme ,ACME")).toEqual(["Acme"]);
    expect(parseTags("здоров’я,Здоров'я")).toEqual(["здоров’я"]);
    expect(parseTags("a b,A b")).toEqual(["a b"]);
  });

  it("formats with a bare comma", () => {
    expect(TAG_SEPARATOR).toBe(",");
    expect(formatTags([" a ", "", "b", "A"])).toBe("a,b");
    expect(formatTags([])).toBe("");
  });

  it("toTagList accepts arrays whose items are comma lists", () => {
    expect(toTagList(["a, b", "c", "B"])).toEqual(["a", "b", "c"]);
  });
});

describe("addTags", () => {
  it("appends new tags at the end, keeping existing order", () => {
    expect(addTags("b,a", "c")).toBe("b,a,c");
    expect(addTags("b,a", ["d", "c"])).toBe("b,a,d,c");
  });

  it("skips tags already present in any case / spacing / apostrophe", () => {
    expect(addTags("Acme", "acme ")).toBe("Acme");
    expect(addTags("Acme", "ACME")).toBe("Acme");
    expect(addTags("здоров’я", "ЗДОРОВ'Я")).toBe("здоров’я");
  });

  it("returns the input unchanged when nothing is added", () => {
    expect(addTags("a, b", "A")).toBe("a, b");
    expect(addTags(null, "")).toBe("");
    expect(addTags("x", " , ")).toBe("x");
  });

  it("works on an empty row and dedupes the additions", () => {
    expect(addTags("", "Trip, trip ,Lviv")).toBe("Trip,Lviv");
    expect(addTags(null, ["a"])).toBe("a");
  });

  it("normalizes the stored form when it writes", () => {
    expect(addTags(" a , b ", "c")).toBe("a,b,c");
  });
});

describe("removeTags", () => {
  it("removes whole tags only, any case", () => {
    expect(removeTags("work,homework,Travel", "WORK")).toBe("homework,Travel");
    expect(removeTags("homework", "work")).toBe("homework");
  });

  it("keeps the order of the remaining tags", () => {
    expect(removeTags("c,b,a", "b")).toBe("c,a");
  });

  it("matches apostrophe / Cyrillic variants", () => {
    expect(removeTags("здоров'я,їжа", "Здоров’я")).toBe("їжа");
  });

  it("removing the last tag leaves an empty string", () => {
    expect(removeTags("solo", "solo")).toBe("");
  });

  it("returns the input unchanged when nothing matches", () => {
    expect(removeTags("a , b", "c")).toBe("a , b");
    expect(removeTags(null, "c")).toBe("");
    expect(removeTags("a", "")).toBe("a");
  });

  it("drops every spelling of the removed tag", () => {
    expect(removeTags("x,Acme,acme ", "acme")).toBe("x");
  });
});

describe("replaceTags", () => {
  it("renames in place", () => {
    expect(replaceTags("a,old,b", "OLD", "new")).toBe("a,new,b");
  });

  it("merges into an existing tag (first position wins)", () => {
    expect(replaceTags("target,x,src", "src", "Target")).toBe("target,x");
    expect(replaceTags("src,x,target", ["src"], "target")).toBe("target,x");
  });

  it("re-spells a tag onto its canonical form", () => {
    expect(replaceTags("acme ", "acme", "Acme")).toBe("Acme");
  });

  it("is a no-op when no source tag is present", () => {
    expect(replaceTags("a, b", "c", "d")).toBe("a, b");
    expect(replaceTags("a", "a", "  ")).toBe("a");
  });
});
