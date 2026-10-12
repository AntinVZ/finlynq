/**
 * Payee Studio P6.1 — the "Existing payee" picker's search / order and the
 * entity type derived from the merchant type. Pure.
 */
import { describe, it, expect } from "vitest";
import { entityRanker } from "@/lib/payees/entity-search";
import { guessPayeeType, payeeMatchKey } from "@/lib/payees/match-key";
import { isPersonsMerchantGroup, payeeTypeForMerchantType, PERSONS_MERCHANT_GROUP } from "@/lib/payees/payee-type";
import { scoreKeys as scoreFromOverview } from "@/lib/payees/overview";
import { scoreKeys } from "@/lib/payees/score-keys";

const ENTITIES = [
  { id: 1, name: "McDonald's", aliases: ["Макдональдз", "MCDONALDS 123 KYIV"], count: 40 },
  { id: 2, name: "Епіцентр", aliases: ["Epicentr K"], count: 120 },
  { id: 3, name: "Сільпо", aliases: [], count: 300 },
  { id: 4, name: "Colin’s", aliases: [], count: 5 },
  { id: 5, name: "Макс Ремонт", aliases: [], count: 2 },
];
const names = (r: Array<{ entity: { name: string } }>) => r.map((x) => x.entity.name);

describe("entity picker search", () => {
  const rank = entityRanker(ENTITIES);

  it("without text lists everything by rows", () => {
    expect(names(rank(""))).toEqual(["Сільпо", "Епіцентр", "McDonald's", "Colin’s", "Макс Ремонт"]);
  });

  it("ignores case and apostrophes", () => {
    expect(names(rank("mcdonalds"))[0]).toBe("McDonald's");
    expect(names(rank("COLINS"))).toEqual(["Colin’s"]);
    expect(names(rank("colin's"))).toEqual(["Colin’s"]);
  });

  it("searches aliases and says which one matched", () => {
    const r = rank("макдон");
    expect(r[0].entity.name).toBe("McDonald's");
    expect(r[0].via).toBe("Макдональдз");
  });

  it("meets Latin and Cyrillic spellings through the matching key", () => {
    expect(names(rank("мак"))).toContain("McDonald's");
    expect(names(rank("mcd"))[0]).toBe("McDonald's");
    expect(names(rank("епицентр"))).toEqual(["Епіцентр"]);
    expect(names(rank("silpo"))).toEqual(["Сільпо"]);
  });

  it("orders name, alias, key and skeleton matches in that order", () => {
    const r = rank("мак");
    expect(r.map((x) => [x.entity.name, x.tier])).toEqual([
      ["Макс Ремонт", 4], // the name contains the text
      ["McDonald's", 3], // an alias does
    ]);
    const bare = entityRanker([
      { id: 1, name: "McDonald's", count: 1 },
      { id: 2, name: "Burger King", count: 1 },
    ]);
    expect(bare("бургер").map((x) => [x.entity.name, x.tier])).toEqual([["Burger King", 2]]); // matching key
    expect(bare("мак").map((x) => [x.entity.name, x.tier])).toEqual([["McDonald's", 1]]); // consonant skeleton
  });

  it("finds nothing for unrelated text", () => {
    expect(rank("zzzz")).toEqual([]);
  });

  it("without text puts entries alike to the merged payees first", () => {
    const alike = entityRanker(ENTITIES, { clusterKeys: [payeeMatchKey("EPITCENTR K10 KYIV")] });
    const r = alike("");
    expect(r[0].entity.name).toBe("Епіцентр");
    expect(r[0].similarity).toBeGreaterThanOrEqual(0.9);
    expect(names(r).slice(1)).toEqual(["Сільпо", "McDonald's", "Colin’s", "Макс Ремонт"]);
  });

  it("the extracted scoreKeys is the one clustering uses", () => {
    expect(scoreFromOverview).toBe(scoreKeys);
    expect(scoreKeys(payeeMatchKey("Ресторан Дача"), payeeMatchKey("Дача"))?.confidence).toBe(0.9);
  });
});

describe("entity type from the merchant type", () => {
  it("«Особи і ФОП» makes a person, or a sole proprietor when the name says ФОП", () => {
    expect(isPersonsMerchantGroup("особи і фоп")).toBe(true);
    expect(payeeTypeForMerchantType(PERSONS_MERCHANT_GROUP, "retail")).toBe("person");
    expect(payeeTypeForMerchantType(PERSONS_MERCHANT_GROUP, "other")).toBe("person");
    expect(payeeTypeForMerchantType(PERSONS_MERCHANT_GROUP, "sole_proprietor")).toBe("sole_proprietor");
  });

  it("recognizes a Cyrillic ФОП prefix (the old ASCII \\b never matched after it)", () => {
    expect(guessPayeeType("ФОП Коваль").type).toBe("sole_proprietor");
    expect(guessPayeeType("фоп коваль іван петрович").type).toBe("sole_proprietor");
    expect(guessPayeeType("FOP Koval").type).toBe("sole_proprietor");
    expect(guessPayeeType("Фопаліно").type).not.toBe("sole_proprietor");
  });

  it("never turns a person-looking name into a merchant", () => {
    expect(payeeTypeForMerchantType("Супермаркети і продукти", "person")).toBe("person");
    expect(payeeTypeForMerchantType("Кафе, ресторани, бари", "sole_proprietor")).toBe("sole_proprietor");
  });

  it("otherwise keeps the guess, then the group's obvious type, then retail", () => {
    expect(payeeTypeForMerchantType("Кафе, ресторани, бари", "service")).toBe("service");
    expect(payeeTypeForMerchantType("Банки і комісії", "other")).toBe("bank");
    expect(payeeTypeForMerchantType("Держава і податки", "other")).toBe("government");
    expect(payeeTypeForMerchantType("Кафе, ресторани, бари", "other")).toBe("retail");
    expect(payeeTypeForMerchantType(null, "other")).toBe("other");
  });
});
