/**
 * Payee Studio P6 stage 2 — the brand decides the payee (B21, B24, B25).
 * Type words (`ресторан`, `АЗС`, `аптека`, …) are not part of the core that
 * clustering compares; person names cluster by sorted tokens; the bank's own
 * service rows are never merchants. Pure.
 */
import { describe, it, expect } from "vitest";
import { coreOfKey, payeeMatchKey } from "@/lib/payees/match-key";
import { buildPayeeClusters, buildPayeeGroups, scoreKeys } from "@/lib/payees/overview";
import { addSlice, spellingOf, type PayeeScan, type SpellingAgg } from "@/lib/payees/scan";
import { bankOperationOf, brandCoreOfKey, buildVocabulary } from "@/lib/payees/type-words";
import { explainPayeePair } from "@/lib/payees/explain";
import { autopilotMatch } from "@/lib/payees/import-assist";
import type { PayeeEntity } from "@/lib/payees/directory";

function fakeScan(payees: string[]): Pick<PayeeScan, "spellings"> {
  const spellings = new Map<string, SpellingAgg>();
  for (const p of payees) {
    const spelling = spellingOf(p);
    const slices = new Map();
    addSlice(slices, -100, "UAH", null, null);
    spellings.set(spelling, {
      spelling,
      key: payeeMatchKey(spelling),
      counts: { transactions: 3, recurring: 0, staged: 0, pending: 0, bank: 0 },
      slices,
      firstDate: "2026-01-01",
      lastDate: "2026-06-01",
      accounts: new Map([[1, 3]]),
      categories: new Map(),
    });
  }
  return { spellings };
}

/** Do these two payees end up in one cluster? */
function together(a: string, b: string): boolean {
  const groups = buildPayeeGroups(fakeScan([a, b]));
  const clusters = buildPayeeClusters(groups);
  const ka = payeeMatchKey(a);
  const kb = payeeMatchKey(b);
  if (ka === kb) return true;
  return clusters.some((c) => c.keys.includes(ka) && c.keys.includes(kb));
}

describe("type words leave the brand", () => {
  it("strips type words from the core while a brand token is left", () => {
    expect(coreOfKey(payeeMatchKey("Ресторан Дача"))).toBe(payeeMatchKey("Дача"));
    expect(coreOfKey(payeeMatchKey("АЗС ОККО 123 Київ"))).toBe(payeeMatchKey("ОККО"));
    const only = brandCoreOfKey(payeeMatchKey("Ресторан"));
    expect(only.typeOnly).toBe(true);
    expect(only.removed).toEqual(["ресторан"]);
    expect(brandCoreOfKey(payeeMatchKey("Medychnyi tsentr Dobrobut")).removed).toEqual(["медичний центр"]);
  });

  it.each([
    ["Ресторан Дача", "Ресторан Липки"],
    ["Готель Прем'єр", "Готель Хілтон"],
    ["АЗС ОККО 123 Київ", "АЗС ВОГ 45 Київ"],
    ["Аптека Подорожник", "Аптека Доброго дня"],
  ])("%s ≠ %s", (a, b) => {
    expect(together(a, b)).toBe(false);
  });

  it("ОККО 123 = АЗС ОККО 456", () => {
    expect(together("ОККО 123", "АЗС ОККО 456")).toBe(true);
    expect(scoreKeys(payeeMatchKey("ОККО 123"), payeeMatchKey("АЗС ОККО 456"))).toMatchObject({ confidence: 0.9, sameBrand: true });
  });

  it("a payee that is only a type word is never clustered and stays unrecognized", () => {
    const groups = buildPayeeGroups(fakeScan(["Ресторан", "Ресторан Дача", "РЕСТОРАН"]));
    const lone = groups.find((g) => g.key === payeeMatchKey("Ресторан"))!;
    expect(lone.brand.typeOnly).toBe(true);
    expect(lone.spellings).toHaveLength(2); // "Ресторан" + "РЕСТОРАН": one name, but…
    expect(buildPayeeClusters(groups)).toEqual([]); // …no cluster, no merge proposal
    expect(scoreKeys(payeeMatchKey("Ресторан"), payeeMatchKey("Ресторан Дача"))).toBeNull(); // no "continues" edge
  });

  it("different brand tokens that are only spelled alike need a decision", () => {
    const clusters = buildPayeeClusters(buildPayeeGroups(fakeScan(["Кафе Мандарин", "Кафе Мандарина"])));
    expect(clusters).toHaveLength(1);
    expect(clusters[0].needsDecision).toBe(true);
    expect(clusters[0].decisionReason).toMatch(/Different brand tokens/);
  });

  it("user words extend the vocabulary; switched-off defaults stop counting", () => {
    const vocab = buildVocabulary({ typeWordsExtra: ["шиномонтаж"], typeWordsOff: ["салон"] });
    expect(coreOfKey(payeeMatchKey("Шиномонтаж Колесо"), vocab)).toBe(payeeMatchKey("Колесо"));
    expect(coreOfKey(payeeMatchKey("Салон Мрія"), vocab)).toBe(payeeMatchKey("Салон Мрія"));
  });

  it("the autopilot never joins different brand tokens", () => {
    const e = (id: number, name: string): PayeeEntity => ({
      id, name, type: "retail", note: null, defaultCategoryId: null, website: null, logo: null, merchantTypeId: null, createdAt: null, updatedAt: null,
      aliases: [{ id, entityId: id, pattern: name, mode: "exact", source: "canonical", createdAt: null }], identifiers: [],
    });
    expect(autopilotMatch("Кафе Мандарина", [e(1, "Кафе Мандарин")], 0.6)).toBeNull();
    expect(autopilotMatch("ОККО 777", [e(2, "АЗС ОККО")], 0.9)?.entity.id).toBe(2);
  });

  it("explain names the stripped word, the core and the brand token", () => {
    const x = explainPayeePair("Ресторан Дача", "Ресторан Липки");
    expect(x.verdict).toBe("separate");
    expect(x.a.brandLine).toBe(`stop word removed: ресторан; core: ${payeeMatchKey("Дача")}; brand token: ${payeeMatchKey("Дача")}`);
  });
});

describe("person names (B24)", () => {
  it("Пасічник Олександр and Олександр Володимирович Пасічник become candidates — never automatic", () => {
    const clusters = buildPayeeClusters(buildPayeeGroups(fakeScan(["Пасічник Олександр", "Олександр Володимирович Пасічник"])));
    expect(clusters).toHaveLength(1);
    expect(clusters[0].groups).toHaveLength(2);
    expect(clusters[0].needsDecision).toBe(true);
    expect(clusters[0].reasons).toContain("same person's name (word order or patronymic differ)");
  });

  it("two shop names in another word order stay apart unless one reads as a person", () => {
    expect(together("Квіти Світ", "Світ Квіти")).toBe(false);
  });
});

describe("bank operations (B25)", () => {
  it.each([
    ["Комісія за переказ", "комісія*"],
    ["Переказ власних коштів", "переказ власних коштів"],
    ["Нарахування відсотків на залишок", "нарахування відсотків"],
    ["Поповнення рахунку", "поповнення рахунку"],
  ])("%s is a bank operation", (payee, pattern) => {
    expect(bankOperationOf(payee)).toBe(pattern);
  });

  it("does not catch merchants with a similar word inside", () => {
    expect(bankOperationOf("Coffee Fee Bar")).toBeNull();
    expect(bankOperationOf("Сільпо")).toBeNull();
  });

  it("is never clustered as a merchant", () => {
    const groups = buildPayeeGroups(fakeScan(["Комісія за переказ", "Комісія за переказ коштів"]));
    expect(groups.every((g) => g.bankOperation != null)).toBe(true);
    expect(buildPayeeClusters(groups)).toEqual([]);
  });

  it("user patterns add and remove bank operations", () => {
    const vocab = buildVocabulary({ bankOpsExtra: ["плата за SMS"], bankOpsOff: ["кешбек"] });
    expect(bankOperationOf("Плата за SMS-інформування", vocab)).toBe("плата за sms");
    expect(bankOperationOf("Кешбек", vocab)).toBeNull();
  });
});
