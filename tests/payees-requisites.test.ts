/**
 * Payee Studio P5f (pure): ІПН / ЄДРПОУ / IBAN check digits, requisites in
 * text (signed codes only, card masks, full card numbers → last 4), masking,
 * identifier queries, type hints.
 */
import { describe, it, expect } from "vitest";
import {
  edrpouChecksumOk,
  extractRequisites,
  ibanChecksumOk,
  identifierQueryRefusal,
  isFullCardNumber,
  maskSensitiveText,
  parseIdentifierQuery,
  rnokppChecksumOk,
  typeHintForCode,
} from "@/lib/payees/requisites";
import { identifierWarnings, normalizeIdentifier } from "@/lib/payees/directory";

describe("check digits", () => {
  it("РНОКПП / ІПН: valid and mistyped", () => {
    expect(rnokppChecksumOk("3123456789")).toBe(true);
    expect(rnokppChecksumOk("3123456780")).toBe(false);
    expect(rnokppChecksumOk("2770718653")).toBe(false);
    expect(rnokppChecksumOk("12345")).toBe(false);
  });
  it("ЄДРПОУ: both weight sets and the +2 retry", () => {
    expect(edrpouChecksumOk("14360570")).toBe(true); // ПриватБанк (< 30 000 000)
    expect(edrpouChecksumOk("32855961")).toBe(true); // 30–60 million: second weight set
    expect(edrpouChecksumOk("00032129")).toBe(true);
    expect(edrpouChecksumOk("14360571")).toBe(false);
    expect(edrpouChecksumOk("3285596")).toBe(false);
  });
  it("IBAN mod-97", () => {
    expect(ibanChecksumOk("UA213223130000026007233566001")).toBe(true);
    expect(ibanChecksumOk("UA213223130000026007233566002")).toBe(false);
  });
});

describe("requisites in text", () => {
  it("takes SIGNED codes only, never a bare 8- or 10-digit number", () => {
    const found = extractRequisites("ТОВ Ромашка, код ЄДРПОУ: 14360570; ІПН 3123456789; рахунок 12345678; 3123456789 без підпису");
    expect(found.filter((f) => f.kind === "edrpou").map((f) => f.value)).toEqual(["14360570"]);
    expect(found.filter((f) => f.kind === "tax_id").map((f) => f.value)).toEqual(["3123456789"]);
    expect(extractRequisites("Оплата 12345678 та 3123456789")).toEqual([]);
    expect(extractRequisites("РНОКПП 3123456780")[0]).toMatchObject({ kind: "tax_id", valid: false });
    expect(extractRequisites("EDRPOU 14360570")[0]).toMatchObject({ kind: "edrpou", valid: true });
  });
  it("card masks in every common form keep the last 4 digits", () => {
    for (const t of ["Переказ на **** 1234", "card *1234", "5168 **** **** 1234", "516874******1234", "4149xx1234"]) {
      const cards = extractRequisites(t).filter((f) => f.kind === "card_last4");
      expect(cards.map((c) => c.value), t).toEqual(["1234"]);
    }
  });
  it("a full card number keeps ONLY its last 4 digits and is masked in shown text", () => {
    const text = "Переказ з картки 4149 4999 1234 5678 Степаненко";
    const found = extractRequisites(text);
    expect(found).toEqual([expect.objectContaining({ kind: "card_last4", value: "5678", masked: "•••• 5678", via: "card_full" })]);
    expect(JSON.stringify(found)).not.toContain("41494999");
    const shown = maskSensitiveText(text);
    expect(shown).toBe("Переказ з картки •••• 5678 Степаненко");
    expect(maskSensitiveText("ІПН 3123456789")).toBe("ІПН ••••••••89");
    expect(maskSensitiveText("UA213223130000026007233566001")).toBe("UA21…6001");
  });
  it("finds an IBAN with spaces", () => {
    expect(extractRequisites("IBAN UA21 3223 1300 0002 6007 2335 6600 1")[0]).toMatchObject({ kind: "iban", value: "UA213223130000026007233566001", valid: true });
  });
});

describe("identifier queries and type hints", () => {
  it("understands a card in any format, an IBAN, an ІПН and an ЄДРПОУ", () => {
    expect(parseIdentifierQuery("5168 **** 1234")).toMatchObject({ kind: "card_last4", value: "1234", strong: false });
    expect(parseIdentifierQuery("****1234")).toMatchObject({ kind: "card_last4", value: "1234" });
    expect(parseIdentifierQuery("1234")).toMatchObject({ kind: "card_last4", value: "1234" });
    expect(parseIdentifierQuery("ua21 3223 1300 0002 6007 2335 6600 1")).toMatchObject({ kind: "iban", value: "UA213223130000026007233566001", strong: true });
    expect(parseIdentifierQuery("3123456789")).toMatchObject({ kind: "tax_id", masked: "••••••••89" });
    expect(parseIdentifierQuery("14360570")).toMatchObject({ kind: "edrpou" });
    expect(parseIdentifierQuery("hello")).toBeNull();
  });
  it("8 digits → legal entity, 10 → person / ФОП; a code that doesn't fit the type is a warning", () => {
    expect(typeHintForCode("14360570")).toBe("company");
    expect(typeHintForCode("3123456789")).toBe("person_or_sole_proprietor");
    expect(identifierWarnings("edrpou", "14360570", "sole_proprietor").join(" ")).toMatch(/ФОП has none/);
    expect(identifierWarnings("tax_id", "3123456789", "company").join(" ")).toMatch(/person or a ФОП/);
    expect(identifierWarnings("tax_id", "3123456780", "person").join(" ")).toMatch(/looks like a typo/);
    expect(identifierWarnings("tax_id", "3123456789", "person")).toEqual([]);
  });
  it("ІПН is exactly 10 digits, EDRPOU exactly 8", () => {
    expect(normalizeIdentifier("tax_id", "312 345 6789")).toBe("3123456789");
    expect(() => normalizeIdentifier("tax_id", "14360570")).toThrow(/10 digits/);
    expect(() => normalizeIdentifier("edrpou", "3123456789")).toThrow(/8 digits/);
  });
});

describe("a full card number is refused, never cut down to its last 4 (P6.2)", () => {
  const FULL = ["4149 4999 1234 5678", "4149499912345678", "4149-4999-1234-5678", "4149 4999 1234 5678 901", "4149*4999*1234*5678"];
  it("as a requisite of a payee (op identifiers, create, proposals, dictionary import)", () => {
    for (const v of [...FULL, "41494999", "12345"]) expect(() => normalizeIdentifier("card_last4", v), v).toThrow(/Повний номер картки не приймається/);
    expect(normalizeIdentifier("card_last4", "5678")).toBe("5678");
    expect(normalizeIdentifier("card_last4", "**** 5678")).toBe("5678");
    expect(normalizeIdentifier("card_last4", "5168 **** **** 5678")).toBe("5678");
    expect(normalizeIdentifier("card_last4", "516874******5678")).toBe("5678");
  });
  it("as a search value (whose, search_transactions identifier / payee_resolve, the Transactions filter)", () => {
    for (const v of FULL) {
      expect(parseIdentifierQuery(v), v).toBeNull();
      expect(identifierQueryRefusal(v), v).toMatch(/Повний номер картки не приймається/);
    }
    for (const v of ["5168 **** 1234", "1234", "3123456789", "14360570", "UA21 3223 1300 0002 6007 2335 6600 1", "Сільпо"]) expect(identifierQueryRefusal(v), v).toBeNull();
    expect(isFullCardNumber("Переказ 4149 4999 1234 5678")).toBe(true);
    expect(isFullCardNumber("5168 **** **** 1234", { strict: true })).toBe(false);
  });
});
