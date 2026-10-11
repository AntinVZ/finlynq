/**
 * Text normalization for matching (src/lib/text-normalize.ts) and every
 * filter / rule / resolver wired to it. DB-free.
 */
import { describe, it, expect } from "vitest";
import {
  APOSTROPHE_VARIANTS,
  containsNormalized,
  equalsNormalized,
  normalizeForMatch,
} from "@/lib/text-normalize";
import { hasExactTag } from "@/lib/reports/tag-filter";
import {
  filterDecryptedBySearch,
  nameLookup,
  nameLookupCandidates,
} from "@/lib/crypto/encrypted-columns";
import { applyRules, suggestCategory, type TransactionRule } from "@/lib/auto-categorize";
import { ruleMatchesEmail } from "@/lib/email-rules/load";
import type { Condition } from "@/lib/rules/schema";
import { compileTextFilters, matchesTextFilters } from "../mcp-server/lib/text-match";
import { fuzzyFind, resolveStrict } from "../mcp-server/tools/_shared";

const NFD_YI = "і\u0308"; // і + combining diaeresis → ї
const NFD_YOT = "и\u0306"; // и + combining breve → й

describe("normalizeForMatch", () => {
  it("folds every apostrophe variant to ASCII '", () => {
    for (const ap of APOSTROPHE_VARIANTS) {
      expect(normalizeForMatch(`Здоров${ap}я`)).toBe("здоров'я");
    }
  });

  it("composes NFD to NFC", () => {
    expect(normalizeForMatch(NFD_YOT)).toBe("й");
    expect(normalizeForMatch(NFD_YI)).toBe("ї");
    expect(normalizeForMatch(`Кра${NFD_YI}на`)).toBe(normalizeForMatch("Країна"));
  });

  it("folds dashes and the minus sign to -", () => {
    for (const d of ["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212"]) {
      expect(normalizeForMatch(`ск${d}агро`)).toBe("ск-агро");
    }
  });

  it("collapses whitespace incl. NBSP, strips zero-width chars, trims", () => {
    expect(normalizeForMatch("  a\u00A0\u00A0b\t\nc  ")).toBe("a b c");
    expect(normalizeForMatch("Si\u200Blpo\u200C\u200D\uFEFF")).toBe("silpo");
  });

  it("lowercases ASCII on the fast path", () => {
    expect(normalizeForMatch("SILPO Store")).toBe("silpo store");
    expect(normalizeForMatch("a  b")).toBe("a b");
    expect(normalizeForMatch(" x")).toBe("x");
  });

  it("does not fold Latin and Cyrillic look-alikes", () => {
    expect(normalizeForMatch("C")).not.toBe(normalizeForMatch("С")); // Latin C vs Cyrillic Es
  });

  it("containsNormalized / equalsNormalized", () => {
    expect(containsNormalized("ТОВ «СК\u2013АГРО»", "ск-агро")).toBe(true);
    expect(containsNormalized(null, "x")).toBe(false);
    expect(equalsNormalized(" Здоров\u2019я ", "здоров'я")).toBe(true);
    expect(equalsNormalized(null, "")).toBe(false);
  });
});

describe("normalizeForMatch fast paths", () => {
  // Reference: the full pipeline with no shortcuts.
  const reference = (s: string) =>
    s
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/['\u2019\u02BC\u2018\u0060\u00B4]/g, "'")
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  const pool = [
    "a", "Z", "1", " ", "  ", "-", "'", "`", "\u00B4", "\u2019", "\u02BC", "\u2018",
    "\u0438", "\u0306", "\u0456", "\u0308", "\u0301", "\u0418", "\u0407", "\u0451",
    "\u00A0", "\t", "\n", "\u200B", "\u200C", "\u200D", "\uFEFF", "\u2013", "\u2014", "\u2212",
    "\u00C5", "\u212B", "\u2126", "\u2000", "\u0374", "\u1100", "\u1161", "\uAC00",
    "\u00AB", "\u00BB", "\u2116", "\u0130", "e", "\u0065\u0301", "\u00E9", "\u0483",
  ];
  it("matches the reference pipeline on random strings", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 20000; i++) {
      const len = 1 + Math.floor(rnd() * 8);
      let s = "";
      for (let j = 0; j < len; j++) s += pool[Math.floor(rnd() * pool.length)];
      expect(normalizeForMatch(s), JSON.stringify(s)).toBe(reference(s));
    }
  });
});

describe("text filters: every apostrophe ↔ every other", () => {
  const pairs: Array<[string, string]> = [];
  for (const a of APOSTROPHE_VARIANTS) for (const b of APOSTROPHE_VARIANTS) pairs.push([a, b]);

  it.each(pairs)("stored %j matches query %j in payee/note/tags/search", (stored, typed) => {
    const row = {
      payee: `Магазин здоров${stored}я`,
      note: `Краса і здоров${stored}я`,
      tags: `краса,здоров${stored}я`,
    };
    const q = `ЗДОРОВ${typed}Я`;
    expect(matchesTextFilters(row, { payee: q })).toBe(true);
    expect(matchesTextFilters(row, { note: q })).toBe(true);
    expect(matchesTextFilters(row, { tags: q })).toBe(true);
    expect(matchesTextFilters(row, { search: q })).toBe(true);
    expect(matchesTextFilters(row, { tagExact: q })).toBe(true);
    // Web API (`/api/transactions?search=`).
    expect(filterDecryptedBySearch([row], q)).toHaveLength(1);
  });

  it("NFD stored vs NFC typed (and back) for й, ї, Здоров'я", () => {
    const row = { payee: `Ча${NFD_YOT} ${NFD_YI}жа`, note: "Здоров\u2019я".normalize("NFD"), tags: null };
    const f = compileTextFilters({ payee: "чай їжа" });
    expect(f(row)).toBe(true);
    expect(matchesTextFilters(row, { note: "здоров'я" })).toBe(true);
    const nfcRow = { payee: "Чай їжа", note: null, tags: null };
    expect(matchesTextFilters(nfcRow, { payee: `ча${NFD_YOT} ${NFD_YI}жа` })).toBe(true);
  });

  it("dashes: СК-АГРО is found by ск\u2013агро", () => {
    const row = { payee: "ТОВ СК-АГРО", note: null, tags: null };
    expect(matchesTextFilters(row, { payee: "ск\u2013агро" })).toBe(true);
    expect(matchesTextFilters(row, { search: "ск\u2014агро" })).toBe(true);
    expect(filterDecryptedBySearch([row], "СК\u2212АГРО")).toHaveLength(1);
  });

  it("still rejects non-matches and null fields", () => {
    expect(matchesTextFilters({ payee: "Silpo" }, { payee: "atb" })).toBe(false);
    expect(matchesTextFilters({ payee: null }, { payee: "x" })).toBe(false);
  });
});

describe("hasExactTag", () => {
  it("matches across case, padding and apostrophes; never as a substring", () => {
    expect(hasExactTag("Agrotrade", "Agrotrade")).toBe(true);
    expect(hasExactTag("Agrotrade", " agrotrade ")).toBe(true);
    expect(hasExactTag("x, Agrotrade ,y", "AGROTRADE")).toBe(true);
    expect(hasExactTag(" agrotrade ", "Agrotrade")).toBe(true);
    expect(hasExactTag("homework", "work")).toBe(false);
    expect(hasExactTag("Здоров\u2019я", "здоров'я")).toBe(true);
    expect(hasExactTag("ск\u2013агро", "СК-АГРО")).toBe(true);
    expect(hasExactTag("work", "  ")).toBe(false);
  });
});

describe("rules: contains / exact across apostrophes", () => {
  const rule = (op: "contains" | "exact", value: string): TransactionRule => ({
    id: 1,
    name: "r",
    conditions: { all: [{ field: "payee", op, value } as Condition] },
    actions: [{ kind: "set_category", categoryId: 7 }],
    isActive: true,
    priority: 0,
  });

  it.each([...APOSTROPHE_VARIANTS])("auto-categorize with stored-apostrophe %j", (ap) => {
    const payee = `Краса і здоров${ap}я`;
    expect(applyRules({ payee }, [rule("contains", "здоров'я")])).not.toBeNull();
    expect(applyRules({ payee }, [rule("exact", "КРАСА І ЗДОРОВ\u2019Я")])).not.toBeNull();
    expect(applyRules({ payee: "Краса" }, [rule("exact", "здоров'я")])).toBeNull();
  });

  it("regex op is unchanged (no normalization)", () => {
    const r: TransactionRule = {
      ...rule("contains", ""),
      conditions: { all: [{ field: "payee", op: "regex", value: "здоров'я" } as Condition] },
    };
    expect(applyRules({ payee: "здоров\u2019я" }, [r])).toBeNull();
    expect(applyRules({ payee: "здоров'я" }, [r])).not.toBeNull();
  });

  it("suggestCategory groups apostrophe spellings of a payee", () => {
    const hist = [
      { payee: "Здоров\u2019я плюс", categoryId: 3 },
      { payee: "здоров'я плюс", categoryId: 3 },
      { payee: "Other", categoryId: 9 },
    ];
    expect(suggestCategory("ЗДОРОВ\u02BCЯ ПЛЮС", hist)).toBe(3);
  });

  it("email rules contains / exact", () => {
    const ctx = { fromAddress: null, subject: "Оплата: Здоров\u2019я", payee: "СК\u2013АГРО" };
    expect(ruleMatchesEmail({ conditions: [{ field: "subject", op: "contains", value: "здоров'я" }] }, ctx)).toBe(true);
    expect(ruleMatchesEmail({ conditions: [{ field: "payee", op: "exact", value: "ск-агро" }] }, ctx)).toBe(true);
    expect(ruleMatchesEmail({ conditions: [{ field: "payee", op: "exact", value: "агро" }] }, ctx)).toBe(false);
  });
});

describe("name resolvers", () => {
  const options = [
    { id: 1, name: "Краса і здоров\u2019я" },
    { id: 2, name: "Продукти" },
  ];
  it("fuzzyFind / resolveStrict match across apostrophes", () => {
    expect(fuzzyFind("краса і здоров'я", options)?.id).toBe(1);
    const r = resolveStrict("Краса і здоров\u02BCя", options, {
      exactFields: [{ field: "name", tier: "exact" }],
      startsFields: [{ field: "name", tier: "startsWith" }],
      substringField: "name",
      substringTier: "substring",
      ambiguous: true,
    });
    expect(r.ok && r.row.id).toBe(1);
  });
});

describe("nameLookup / nameLookupCandidates", () => {
  const dek = Buffer.alloc(32, 7);

  it("nameLookup hashes are unchanged (values computed before this change)", () => {
    expect(nameLookup(dek, "  Chase   CHECKING ")).toBe("VN_9_Wmeb7xz9TV2L9u8oxOUagiW7D4DQr0HifGvYMk");
    expect(nameLookup(dek, "Краса і Здоров\u2019я")).toBe("AuF2yiCTNzCqEjT0gQZ8qluthbVrzxPDQ55iOt0VqFc");
    expect(nameLookup(dek, "Краса і здоров'я")).toBe("CYcizPg4qGPoMilLXnyAnRhBpBXrmxUCfZgLzB_RVw0");
  });

  it("includes the original hash first, plus every apostrophe spelling", () => {
    const c = nameLookupCandidates(dek, "Краса і здоров'я");
    expect(c[0]).toBe(nameLookup(dek, "Краса і здоров'я"));
    for (const ap of APOSTROPHE_VARIANTS) {
      expect(c).toContain(nameLookup(dek, `Краса і здоров${ap}я`));
    }
    expect(new Set(c).size).toBe(c.length);
  });

  it("includes NFC and NFD spellings", () => {
    const c = nameLookupCandidates(dek, "Чай");
    expect(c).toContain(nameLookup(dek, "Чай"));
    expect(c).toContain(nameLookup(dek, "Чай".normalize("NFD")));
    const d = nameLookupCandidates(dek, "Чаи\u0306".normalize("NFD"));
    expect(d).toContain(nameLookup(dek, "Чай"));
  });

  it("a plain ASCII name yields just its own hash", () => {
    expect(nameLookupCandidates(dek, "Groceries")).toEqual([nameLookup(dek, "Groceries")]);
  });
});
