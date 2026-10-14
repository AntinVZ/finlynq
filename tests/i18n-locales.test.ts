/**
 * Interface languages (P8 stage 6): the message files, the ICU subset,
 * plural forms, Intl formatting, language negotiation and pseudo locales.
 */
import { describe, it, expect } from "vitest";
import { checkI18n } from "../scripts/lint-i18n";
import { formatMessage, messageVariables } from "@/lib/i18n/format-message";
import { availableLocales, negotiateLocale, translate } from "@/lib/i18n";
import { formatDate, formatMoney, formatNumber } from "@/lib/i18n/format";
import { localeEntry } from "@/lib/i18n/registry";
import { DEFAULT_MERCHANT_TYPES, localizeMerchantType } from "@/lib/payees/merchant-types";
import type { MessageKey } from "@/lib/i18n";

/** Intl uses no-break spaces as group separators; compare with plain ones. */
const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

describe("message files", () => {
  it("have the same keys, variables and plurals in every language, and no unused key", () => {
    expect(checkI18n()).toEqual([]);
  });

  it("translate every built-in merchant type", () => {
    for (const g of DEFAULT_MERCHANT_TYPES) {
      for (const lang of ["en", "uk"]) {
        expect(translate(lang, `mtypeGroup.${g.code}` as MessageKey)).not.toMatch(/^mtypeGroup\./);
        for (const p of g.names ?? [{ code: g.code }]) expect(translate(lang, `mtype.${p.code}` as MessageKey)).not.toMatch(/^mtype\./);
      }
    }
  });
});

describe("formatMessage", () => {
  const rows = "{n, plural, one {# рядок} few {# рядки} many {# рядків} other {# рядка}}";
  it("picks the Ukrainian plural form", () => {
    expect(formatMessage(rows, "uk", { n: 1 })).toBe("1 рядок");
    expect(formatMessage(rows, "uk", { n: 3 })).toBe("3 рядки");
    expect(formatMessage(rows, "uk", { n: 11 })).toBe("11 рядків");
    expect(formatMessage(rows, "uk", { n: 21 })).toBe("21 рядок");
    expect(formatMessage(rows, "uk", { n: 1.5 })).toBe("1,5 рядка");
    expect(sp(formatMessage(rows, "uk", { n: 12345 }))).toBe("12 345 рядків");
  });

  it("prefers an exact =N branch, fills variables, keeps unknown ones visible", () => {
    const t = "{n, plural, =0 {nothing} one {# item for {who}} other {# items}}";
    expect(formatMessage(t, "en", { n: 0 })).toBe("nothing");
    expect(formatMessage(t, "en", { n: 1, who: "Ann" })).toBe("1 item for Ann");
    expect(formatMessage(t, "en", { n: 2 })).toBe("2 items");
    expect(formatMessage("Hi {name}", "en", {})).toBe("Hi {name}");
  });

  it("lists variables, including plural selectors and nested ones", () => {
    expect(messageVariables("{a} {n, plural, one {# {b}} other {#}}")).toEqual(["a", "b", "n"]);
  });
});

describe("translate", () => {
  it("uses the language, then English", () => {
    expect(translate("uk", "common.cancel")).toBe("Скасувати");
    expect(translate("en", "common.cancel")).toBe("Cancel");
    expect(translate("xx", "common.cancel")).toBe("Cancel");
    expect(translate("uk", "common.rows", { n: 2 })).toBe("2 рядки");
    expect(translate("en", "common.rows", { n: 1 })).toBe("1 row");
  });
});

describe("Intl formatting", () => {
  it("formats numbers, money and dates for the language", () => {
    expect(sp(formatNumber("uk", 38400))).toBe("38 400");
    expect(sp(formatMoney("uk", 38400, "UAH", { compact: true }))).toBe("38,4 тис. ₴");
    expect(formatMoney("en", 1234.5, "USD")).toBe("$1,234.50");
    expect(formatMoney("en", 2, "BTC")).toMatch(/BTC/);
    expect(sp(formatDate("uk", "2026-10-13"))).toBe("13 жовт. 2026 р.");
    expect(formatDate("en", "2026-10", "month")).toBe("Oct 2026");
    expect(formatDate("en", null)).toBe("—");
  });
});

describe("language choice", () => {
  it("negotiates Accept-Language, else English", () => {
    expect(negotiateLocale("uk-UA,uk;q=0.9,en;q=0.8")).toBe("uk");
    expect(negotiateLocale("de-DE,en;q=0.5")).toBe("en");
    expect(negotiateLocale("fr")).toBe("en");
    expect(negotiateLocale(["en-GB", "uk"])).toBe("en");
    expect(negotiateLocale(null)).toBe("en");
  });

  it("offers pseudo locales outside production; they keep variables intact", () => {
    expect(availableLocales().map((l) => l.code)).toEqual(expect.arrayContaining(["en", "uk", "en-XA", "ar-XB"]));
    const long = localeEntry("en-XA").messages["common.rows"];
    expect(long.startsWith("[")).toBe(true);
    expect(messageVariables(long)).toEqual(["n"]);
    expect(translate("en-XA", "common.rows", { n: 2 })).toMatch(/^\[\{?.*2 ŕöŵš/);
    expect(localeEntry("ar-XB").meta.dir).toBe("rtl");
  });
});

describe("built-in merchant types in the interface language", () => {
  const tr = (lang: string) => (key: string) => translate(lang, key as MessageKey);
  it("shows an unchanged built-in under its translation and a renamed one as written", () => {
    expect(localizeMerchantType({ group: "Кафе, ресторани, бари", name: "Ресторани" }, tr("en"))).toEqual({ group: "Cafés, restaurants, bars", name: "Restaurants" });
    expect(localizeMerchantType({ group: "Кафе, ресторани, бари", name: "Ресторани" }, tr("uk"))).toEqual({ group: "Кафе, ресторани, бари", name: "Ресторани" });
    expect(localizeMerchantType({ group: "Їжа", name: "Ресторани", code: "restaurant" }, tr("en"))).toEqual({ group: "Їжа", name: "Restaurants" });
    expect(localizeMerchantType({ group: "Мої", name: "Шиномонтаж" }, tr("en"))).toEqual({ group: "Мої", name: "Шиномонтаж" });
  });
});
