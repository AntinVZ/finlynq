/**
 * Payee Studio P5a (pure): suggestions for the payee boxes and the
 * "why (not) clustered?" explanation.
 */
import { describe, it, expect } from "vitest";
import { buildSuggestIndex, querySuggestIndex } from "@/lib/payees/suggest";
import { explainPayeePair } from "@/lib/payees/explain";
import { buildPayeeMatcher, type PayeeEntity } from "@/lib/payees/directory";

const entity = (id: number, name: string, aliases: string[] = [], type: PayeeEntity["type"] = "retail"): PayeeEntity => ({
  id,
  name,
  type,
  note: null,
  defaultCategoryId: null,
  createdAt: null,
  updatedAt: null,
  aliases: [
    { id: id * 100, entityId: id, pattern: name, mode: "exact", source: "canonical", createdAt: null },
    ...aliases.map((p, i) => ({ id: id * 100 + i + 1, entityId: id, pattern: p, mode: "exact" as const, source: "manual", createdAt: null })),
  ],
  identifiers: [],
});

const directory = [entity(1, "Епіцентр", ["EPITCENTR K10 KYIV 360616", "Epicentr"]), entity(2, "Сільпо", ["SILPO 1234"])];
const recent = [
  { payee: "Epicentr", date: "2026-09-01" },
  { payee: "Кав'ярня Ріг", date: "2026-10-01" },
  { payee: "Кав'ярня Ріг", date: "2026-08-01" },
  { payee: "Нова пошта", date: "2026-07-01" },
];

describe("payee suggestions", () => {
  const index = buildSuggestIndex(directory, recent);

  it("offers the canonical name for an alias and finds Latin spellings of a Cyrillic name", () => {
    const hits = querySuggestIndex(index, "epit");
    expect(hits[0]).toMatchObject({ value: "Епіцентр" });
    expect(hits.some((h) => h.kind === "alias" && h.label === "EPITCENTR K10 KYIV 360616" && h.value === "Епіцентр")).toBe(true);
  });

  it("finds a directory entry by its own name first", () => {
    expect(querySuggestIndex(index, "сіл")[0]).toMatchObject({ value: "Сільпо", kind: "entity", entityId: 2 });
  });

  it("lists recent payees that are not in the directory, de-duplicated with counts", () => {
    const hits = querySuggestIndex(index, "кав");
    expect(hits).toEqual([expect.objectContaining({ value: "Кав'ярня Ріг", kind: "recent", count: 2 })]);
    // "Epicentr" is an alias already → not repeated as a recent payee.
    expect(querySuggestIndex(index, "").some((h) => h.kind === "recent" && h.value === "Epicentr")).toBe(false);
  });

  it("empty query: recent payees newest first, then the directory", () => {
    const hits = querySuggestIndex(index, "", 10);
    expect(hits[0].value).toBe("Кав'ярня Ріг");
    expect(hits.map((h) => h.kind)).toContain("entity");
    expect(hits.some((h) => h.kind === "alias")).toBe(false);
  });
});

describe("explain (why not clustered?)", () => {
  it("same matching key → one name", () => {
    const x = explainPayeePair("EPITCENTR K10 KYIV 360616", "Епіцентр");
    expect(x.verdict).toBe("same_name");
  });

  it("one name continues the other → clustered with its score", () => {
    const x = explainPayeePair("Степаненко", "Степаненко компенсація житла");
    expect(x.verdict).toBe("clustered");
    expect(x.score).toMatchObject({ confidence: 0.75, reason: "one name continues the other" });
  });

  it("a person is never paired with a merchant", () => {
    const x = explainPayeePair("Деркач Олександр Петрович", "Деркач Маркет");
    expect(x.verdict).toBe("separate");
    expect(x.reasons.join(" ")).toMatch(/private person/);
  });

  it("names that start differently are never compared", () => {
    const x = explainPayeePair("Rozetka", "Comfy");
    expect(x.verdict).toBe("separate");
    expect(x.reasons.join(" ")).toMatch(/start alike/);
  });

  it("both resolving to one entity → settled", () => {
    const x = explainPayeePair("Epicentr", "EPITCENTR K10 KYIV 360616", buildPayeeMatcher(directory));
    expect(x.verdict).toBe("settled");
    expect(x.a.entity).toEqual({ id: 1, name: "Епіцентр" });
  });
});
