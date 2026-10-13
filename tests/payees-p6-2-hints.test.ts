/**
 * Payee Studio P6.2 stage 1 (pure): merchant-type hints come from the
 * canonical name only (B29) — an alias match is a weak hint naming the
 * alias, different hints mark the entry mixed — and every type word of the
 * vocabulary counts (B30). The canonical spelling keeps the letter case of
 * the most used mixed-case spelling.
 */
import { describe, it, expect } from "vitest";
import { defaultMerchantTypes, entityMerchantTypeHints, suggestMerchantType } from "@/lib/payees/merchant-types";
import { buildVocabulary, typeWordSynonymKeys } from "@/lib/payees/type-words";
import { canonicalSpelling, caseOnlyChange } from "@/lib/payees/match-key";
import { buildPayeeClusters, buildPayeeGroups } from "@/lib/payees/overview";
import type { PayeeScan, SpellingAgg } from "@/lib/payees/scan";
import { payeeMatchKey } from "@/lib/payees/match-key";

const types = defaultMerchantTypes();
const ent = (name: string, aliases: string[] = []) => ({ name, aliases: aliases.map((pattern) => ({ pattern, mode: "exact" })) });

describe("B30: every type word of the vocabulary suggests its type", () => {
  it.each([
    ["AZS OKKO 51 KYIV", "Пальне (АЗС)"],
    ["WOG АЗС 22", "Пальне (АЗС)"],
    ["Apteka Podorozhnyk", "Аптеки"],
    ["Аптека Доброго Дня", "Аптеки"],
    ["Pharmacy Plus", "Аптеки"],
    ["Кафе Львівські пляцки", "Кафе"],
    ["Restaurant Pesto", "Ресторани"],
    ["Bar Barvy", "Бари"],
    ["Hotel Bristol", "Готелі"],
    ["Gotel Dnipro", "Готелі"],
  ])("%s → %s", (name, type) => {
    expect(suggestMerchantType([name], types)?.type.name).toBe(type);
  });

  it("a user word can carry a hint: «кальянна = Кафе, ресторани, бари → Бари»", () => {
    const vocab = buildVocabulary({ typeWordsExtra: ["кальянна = Кафе, ресторани, бари → Бари"] });
    expect(suggestMerchantType(["Кальянна Дим"], types, { vocab })?.type.name).toBe("Бари");
  });

  it("a type word stands for its synonyms (аптека = apteka = pharmacy)", () => {
    const keys = typeWordSynonymKeys("аптека");
    for (const w of ["apteka", "pharmacy", "фармація"]) expect(keys).toContain(payeeMatchKey(w));
    expect(keys).not.toContain(payeeMatchKey("hotel"));
    expect(typeWordSynonymKeys("шиномонтаж")).toEqual([payeeMatchKey("шиномонтаж")]);
  });
});

describe("B29: only the canonical name gives a strong hint", () => {
  it("«Епіцентр» with an alias «Apteka Epitsentr» gets only a weak hint naming the alias", () => {
    const h = entityMerchantTypeHints(ent("Епіцентр", ["Epitsentr", "Apteka Epitsentr"]), types);
    expect(h.hint).toMatchObject({ name: "Аптеки", strength: "weak", field: "alias", matched: "Apteka Epitsentr" });
    expect(h.hint!.reason).toContain("alias “Apteka Epitsentr”");
    expect(h.mixed).toBe(false);
  });

  it("a name hint is strong", () => {
    const h = entityMerchantTypeHints(ent("АЗС ОККО", ["OKKO 51"]), types);
    expect(h.hint).toMatchObject({ name: "Пальне (АЗС)", strength: "strong", field: "name" });
  });

  it("different hints from the name and an alias make the entry mixed", () => {
    const h = entityMerchantTypeHints(ent("Кафе Дача", ["Hotel Dacha"]), types);
    expect(h.mixed).toBe(true);
    expect(h.mixedReason).toContain("mixed:");
    expect(h.mixedReason).toContain("Готелі");
  });
});

describe("canonical spelling keeps the letter case", () => {
  it("the most used mixed-case spelling wins over ALL CAPS", () => {
    expect(canonicalSpelling([{ spelling: "PLAYSTATION NETWORK", count: 9 }, { spelling: "PlayStation Network", count: 2 }])).toBe("PlayStation Network");
    expect(canonicalSpelling([{ spelling: "PlayStation Network 4411 London", count: 3 }])).toBe("PlayStation Network");
  });

  it("only ALL CAPS → title case of the most used spelling", () => {
    expect(canonicalSpelling([{ spelling: "ATB MARKET", count: 5 }])).toBe("Atb Market");
  });

  it("groups and clusters suggest the mixed-case form", () => {
    const sp = (spelling: string, n: number): SpellingAgg =>
      ({
        spelling,
        key: payeeMatchKey(spelling),
        counts: { transactions: n, recurring: 0, staged: 0, pending: 0, bank: 0 },
        slices: new Map(),
        accounts: new Map(),
        categories: new Map(),
        firstDate: null,
        lastDate: null,
      }) as unknown as SpellingAgg;
    const scan = { spellings: new Map([["a", sp("PLAYSTATION NETWORK", 9)], ["b", sp("PlayStation Network", 2)], ["c", sp("PLAYSTATIONNETWORK", 4)]]) } as unknown as Pick<PayeeScan, "spellings">;
    const groups = buildPayeeGroups(scan);
    expect(groups.find((g) => g.spellings.length === 2)!.suggestedName).toBe("PlayStation Network");
    const clusters = buildPayeeClusters(groups);
    for (const c of clusters) expect(c.suggestedName).toBe("PlayStation Network");
  });

  it("a case-only rename is recognized", () => {
    expect(caseOnlyChange("PLAYSTATION NETWORK", "PlayStation Network")).toBe(true);
    expect(caseOnlyChange("PSN", "PlayStation Network")).toBe(false);
    expect(caseOnlyChange("Same", "Same")).toBe(false);
  });
});
