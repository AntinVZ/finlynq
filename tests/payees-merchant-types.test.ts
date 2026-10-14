/**
 * Payee Studio P6 stage 3 — merchant types (B26): the starting set, text
 * references, report filters and suggestions. Pure.
 */
import { describe, it, expect } from "vitest";
import {
  defaultMerchantTypes,
  findMerchantType,
  formatMerchantType,
  mccInText,
  merchantTypeFilter,
  parseMerchantTypeText,
  suggestMerchantType,
} from "@/lib/payees/merchant-types";

const types = defaultMerchantTypes();

describe("merchant types", () => {
  it("ships the starting set with one group of three positions", () => {
    expect(types.filter((t) => t.group === "Кафе, ресторани, бари").map((t) => t.name)).toEqual(["Кафе", "Ресторани", "Бари"]);
    expect(types.find((t) => t.group === "Банківські операції")).toBeTruthy();
    expect(types).toHaveLength(22); // P8 stage 11 added «Колеги»
    expect(types.every((t) => t.id == null)).toBe(true);
  });

  it("formats and parses group → position", () => {
    expect(formatMerchantType({ group: "Кафе, ресторани, бари", name: "Ресторани" })).toBe("Кафе, ресторани, бари → Ресторани");
    expect(formatMerchantType({ group: "Аптеки", name: "Аптеки" })).toBe("Аптеки");
    expect(parseMerchantTypeText("Кафе, ресторани, бари → Бари")).toEqual({ group: "Кафе, ресторани, бари", name: "Бари" });
    expect(parseMerchantTypeText("Готелі / Готелі")).toEqual({ group: "Готелі", name: "Готелі" });
  });

  it("finds a type by a position, a one-position group, or group → position", () => {
    expect(findMerchantType(types, "ресторани")?.name).toBe("Ресторани");
    expect(findMerchantType(types, "Аптеки")?.group).toBe("Аптеки");
    expect(findMerchantType(types, "Кафе, ресторани, бари → Кафе")?.name).toBe("Кафе");
    expect(findMerchantType(types, "Кафе, ресторани, бари")).toBeNull(); // a group with three positions is ambiguous
  });

  it("filters by group or by position", () => {
    const byGroup = merchantTypeFilter("Кафе, ресторани, бари");
    expect(types.filter(byGroup)).toHaveLength(3);
    expect(types.filter(merchantTypeFilter("Бари"))).toHaveLength(1);
    expect(merchantTypeFilter("без типу")(null)).toBe(true);
    expect(byGroup(null)).toBe(false);
  });

  it("suggests from type words, bank operations and an MCC — never more", () => {
    expect(suggestMerchantType(["Кав'ярня Львівська"], types)?.type.name).toBe("Кафе");
    expect(suggestMerchantType(["Піцерія Челентано"], types)?.type.name).toBe("Кафе");
    expect(suggestMerchantType(["Ресторан Дача"], types)?.type.name).toBe("Ресторани");
    expect(suggestMerchantType(["Irish Pub"], types)?.type.name).toBe("Бари");
    expect(suggestMerchantType(["Apteka 911"], types)?.type.name).toBe("Аптеки");
    expect(suggestMerchantType(["Комісія за переказ"], types)?.type.group).toBe("Банківські операції");
    expect(suggestMerchantType(["SHOP 123 MCC 5812"], types)).toMatchObject({ source: "mcc", type: { name: "Ресторани" } });
    expect(suggestMerchantType(["Сільпо"], types)).toBeNull();
    expect(mccInText("mcc:5411")).toBe("5411");
  });
});
