/**
 * Payee Studio P1 — matching keys, type guesses, groups and clusters. Pure.
 */
import { describe, it, expect } from "vitest";
import {
  cleanPayeeDisplay,
  guessPayeeType,
  payeeMatchKey,
  payeeTokens,
  transliterateToLatin,
} from "@/lib/payees/match-key";
import { buildPayeeClusters, buildPayeeGroups, unrecognizedGroups } from "@/lib/payees/overview";
import { addSlice, spellingOf, type PayeeScan, type SpellingAgg } from "@/lib/payees/scan";
import { normalizeForMatch } from "@/lib/text-normalize";
import { PAYEE_FIXTURES } from "./helpers/payee-fixtures";

function fakeScan(entries: Array<{ payee: string; count: number; amount?: number }>): Pick<PayeeScan, "spellings"> {
  const spellings = new Map<string, SpellingAgg>();
  for (const e of entries) {
    const spelling = spellingOf(e.payee);
    const slices = new Map();
    for (let i = 0; i < e.count; i++) addSlice(slices, e.amount ?? -10, "UAH", null, null);
    spellings.set(spelling, {
      spelling,
      key: payeeMatchKey(spelling),
      counts: { transactions: e.count, recurring: 0, staged: 0, pending: 0, bank: 0 },
      slices,
      firstDate: "2026-01-01",
      lastDate: "2026-06-01",
      accounts: new Map([[1, e.count]]),
      categories: new Map(),
    });
  }
  return { spellings };
}

describe("payeeMatchKey", () => {
  it("folds Latin, Cyrillic and terminal-noise spellings of Epicentr to one key", () => {
    const keys = ["Epicentr", "Епіцентр", "EPITCENTR K10 KYIV 360616", "epicentr  "].map(payeeMatchKey);
    expect(new Set(keys).size).toBe(1);
    expect(payeeMatchKey("Епіцентр К")).not.toBe(keys[0]);
  });

  it("ignores apostrophe style and letter case", () => {
    expect(payeeMatchKey("Colin's")).toBe(payeeMatchKey("Colin’s"));
    expect(payeeMatchKey("Атб Маркет")).toBe(payeeMatchKey("ATB MARKET"));
    expect(payeeMatchKey("BULOCHKA SHOP")).toBe(payeeMatchKey("Булочка шоп"));
    expect(payeeMatchKey("Деркач Олександр Петрович")).toBe(payeeMatchKey("DERKACH OLEKSANDR PETROVYCH"));
  });

  it("strips POS prefixes, long numbers, ids, places and web suffixes", () => {
    expect(payeeMatchKey("POS PURCHASE SILPO 1234 KYIV UA")).toBe(payeeMatchKey("Silpo"));
    expect(payeeMatchKey("BINANCE.COM*A1B2C3D4E5 1234567890123 LONDON GB")).toBe(payeeMatchKey("Binance"));
    // A place word is kept when it is the start of the name.
    expect(payeeMatchKey("Kyiv Food Market")).toContain("kiv");
    expect(payeeTokens("EPITCENTR K10 KYIV 360616").noisy).toBe(true);
    expect(payeeTokens("Epicentr").noisy).toBe(false);
  });

  it("is empty for an empty payee and never touches normalizeForMatch", () => {
    expect(payeeMatchKey("")).toBe("");
    expect(payeeMatchKey(null)).toBe("");
    // normalizeForMatch still does NOT fold Latin ↔ Cyrillic (the key does, separately).
    expect(normalizeForMatch("Epicentr")).not.toBe(normalizeForMatch("Епіцентр"));
    expect(transliterateToLatin("щастя")).toBe("shchastia");
  });
});

describe("cleanPayeeDisplay / guessPayeeType", () => {
  it("suggests a tidy name", () => {
    expect(cleanPayeeDisplay("EPITCENTR K10 KYIV 360616")).toBe("Epitcentr");
    expect(cleanPayeeDisplay("BINANCE.COM*A1B2C3D4E5 1234567890123 LONDON GB")).toBe("Binance");
    expect(cleanPayeeDisplay("Colin’s")).toBe("Colin’s");
    expect(cleanPayeeDisplay("FOP DAVYDZON O. M.")).toBe("FOP Davydzon O. M.");
  });

  it("recognises people and sole proprietors", () => {
    expect(guessPayeeType("Деркач Олександр Петрович")).toMatchObject({ type: "person", isPerson: true });
    expect(guessPayeeType("DERKACH OLEKSANDR PETROVYCH")).toMatchObject({ type: "person", isPerson: true });
    expect(guessPayeeType("FOP DAVYDZON O. M.")).toMatchObject({ type: "sole_proprietor", isPerson: true });
    expect(guessPayeeType("Атб Маркет")).toMatchObject({ type: "retail", isPerson: false });
    expect(guessPayeeType("BINANCE.COM")).toMatchObject({ type: "service" });
    expect(guessPayeeType("Something Unknown").type).toBe("other");
  });
});

describe("groups and clusters", () => {
  const groups = buildPayeeGroups(fakeScan(PAYEE_FIXTURES), { convert: (s) => s.reduce((n, x) => n + x.totalAmount, 0) });
  const clusters = buildPayeeClusters(groups);
  const groupOf = (payee: string) => groups.find((g) => g.key === payeeMatchKey(payee))!;
  const clusterOf = (payee: string) => clusters.find((c) => c.keys.includes(payeeMatchKey(payee)));

  it("puts the three Epicentr spellings in one group, most used first", () => {
    const g = groupOf("Epicentr");
    expect(g.spellings.map((s) => s.spelling)).toEqual(["Епіцентр", "Epicentr", "EPITCENTR K10 KYIV 360616"]);
    expect(g.count).toBe(28);
    expect(g.noisy).toBe(true);
    expect(g.suggestedName).toBe("Епіцентр");
    expect(g.total).toBe(20 * -450 + 5 * -300 + 3 * -120);
  });

  it("clusters Епіцентр К with Epicentr as a near match with reasons", () => {
    const c = clusterOf("Епіцентр К")!;
    expect(c.keys).toContain(payeeMatchKey("Epicentr"));
    expect(c.confidence).toBeGreaterThanOrEqual(0.85);
    expect(c.confidence).toBeLessThan(0.95);
    expect(c.reasons.join(" ")).toMatch(/one-letter suffix/);
    expect(c.reasons.join(" ")).toMatch(/transliteration|terminal noise/);
    expect(c.needsDecision).toBe(false);
  });

  it("puts people in needs-decision and never pairs them with merchants", () => {
    const person = clusterOf("Деркач Олександр Петрович")!;
    expect(person.needsDecision).toBe(true);
    expect(person.decisionReason).toMatch(/private person/);
    expect(person.keys).toHaveLength(1);
    // The sole proprietor is a singleton (one spelling): not a cluster, but flagged in its group.
    expect(clusterOf("FOP DAVYDZON O. M.")).toBeUndefined();
    expect(groupOf("FOP DAVYDZON O. M.").type.isPerson).toBe(true);
    for (const c of clusters) {
      const kinds = new Set(c.groups.map((g) => g.type.isPerson));
      expect(kinds.size).toBe(1);
    }
  });

  it("clusters apostrophe and Cyrillic/Latin variants at high confidence", () => {
    expect(clusterOf("Colin's")!.confidence).toBe(0.95);
    expect(clusterOf("Colin's")!.reasons.join(" ")).toMatch(/apostrophes/);
    expect(clusterOf("ATB MARKET")!.groups[0].spellings).toHaveLength(2);
    expect(clusterOf("BULOCHKA SHOP")).toBeUndefined();
  });

  it("does not pair a person with a merchant that merely looks alike", () => {
    const g = buildPayeeGroups(fakeScan([
      { payee: "Davydenko Shop", count: 3 },
      { payee: "Давиденко Олена Іванівна", count: 2 },
    ]));
    expect(buildPayeeClusters(g)).toHaveLength(0);
  });

  it("lists every keyed group as unrecognized while the directory is empty", () => {
    expect(unrecognizedGroups(groups)).toHaveLength(groups.filter((g) => g.key).length);
  });

  it("stays fast on thousands of distinct payees", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const word = () => Array.from({ length: 5 + Math.floor(rnd() * 5) }, () => "abdefhklmnoprstuvz"[Math.floor(rnd() * 18)]).join("");
    const many = Array.from({ length: 6000 }, () => ({ payee: `${word()} ${word()}`, count: 1 }));
    const t0 = Date.now();
    const g = buildPayeeGroups(fakeScan(many));
    expect(g.length).toBeGreaterThan(5000);
    buildPayeeClusters(g);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
