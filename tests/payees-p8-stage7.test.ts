/**
 * P8 stage 7 — country packs, the ID registry, transliteration plugins and
 * dictionary v2. Acceptance: a test PL pack, with no code change, shows its
 * type words and validates a NIP.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activePacks, BUILTIN_PACKS, packIdTypes, packVocabulary, parsePack, summarizePack, UA_PACK } from "@/lib/payees/packs";
import { detectIdTypes, idType, ID_TYPES, KIND_TO_ID_TYPE } from "@/lib/payees/id-registry";
import { CYRILLIC_UK, GREEK_EL, MATCHING_CHAIN, registerTranslit, translitPlugin, transliterate } from "@/lib/payees/translit";
import { payeeMatchKey } from "@/lib/payees/match-key";
import { bankOperationOf, brandCoreOfKey, buildVocabulary, DEFAULT_BANK_OPERATIONS, DEFAULT_TYPE_WORDS, PAYMENT_CHANNELS } from "@/lib/payees/type-words";
import { buildDictionary, DICTIONARY_VERSION, dictionaryToJson, parseDictionary } from "@/lib/payees/dictionary";
import { DEFAULT_MERCHANT_TYPES } from "@/lib/payees/merchant-types";
import { vocabularyOf } from "@/lib/payees/settings";

const PL_TEXT = readFileSync(join(__dirname, "fixtures", "pack-pl.json"), "utf8");

describe("P8 stage 7 — acceptance: a PL pack without code changes", () => {
  const { pack, errors } = parsePack(PL_TEXT);

  it("imports as data", () => {
    expect(errors).toEqual([]);
    expect(pack?.country).toBe("PL");
    const s = summarizePack(pack!);
    expect(s).toMatchObject({ typeWords: 6, bankOperations: 2, channels: 3, mcc: 1, builtin: false, unknownTypeCodes: [] });
    expect(s.idTypes.map((t) => t.label)).toEqual(["NIP", "REGON", "VAT", "IBAN", "•••• 0000"]);
  });

  it("shows its type words: they are cut from the brand core with their merchant type", () => {
    const settings = { typeWordsExtra: [], typeWordsOff: [], bankOpsExtra: [], bankOpsOff: [] };
    const without = vocabularyOf(settings);
    const withPl = vocabularyOf({ ...settings, customPacks: [pack!] });
    const key = payeeMatchKey("Stacja paliw Gemini");
    expect(brandCoreOfKey(key, without).removed).toEqual([]);
    const core = brandCoreOfKey(key, withPl);
    expect(core.core).toBe(payeeMatchKey("Gemini"));
    expect(core.removed).toEqual(["stacja paliw"]);
    expect(core.hint?.code).toBe("fuel");
    expect(brandCoreOfKey(payeeMatchKey("Piekarnia Putka"), withPl)).toMatchObject({ core: payeeMatchKey("Putka"), hint: null });
    expect(bankOperationOf("Prowizja za przelew", withPl)).not.toBeNull();
    expect(bankOperationOf("Prowizja za przelew", without)).toBeNull();
  });

  it("validates a NIP (check digit), and the active packs decide which ID types apply", () => {
    const ids = packIdTypes(activePacks({ customPacks: [pack!] }));
    expect(ids).toContain("pl_nip");
    const good = detectIdTypes("526-104-08-28", ids).find((m) => m.id === "pl_nip");
    expect(good?.check).toEqual({ ok: true, normalized: "5261040828" });
    const bad = detectIdTypes("5261040829", ids).find((m) => m.id === "pl_nip");
    expect(bad?.check).toMatchObject({ ok: false, reason: "checksum" });
    // UA alone does not know NIP.
    expect(detectIdTypes("5261040828", packIdTypes(activePacks())).some((m) => m.id === "pl_nip")).toBe(false);
  });

  it("rejects what a pack must not carry and built-in ids", () => {
    expect(parsePack("{").errors[0].message).toBe("Not JSON");
    expect(parsePack({ ...JSON.parse(PL_TEXT), id: "ua" }).pack).toBeNull();
    expect(parsePack({ ...JSON.parse(PL_TEXT), format: "x" }).pack).toBeNull();
    expect(parsePack({ ...JSON.parse(PL_TEXT), typeWords: [{ word: "x".repeat(61) }] }).pack).toBeNull();
    // Unknown keys (amounts, notes, names of people) are dropped, never stored.
    const r = parsePack({ ...JSON.parse(PL_TEXT), entries: [{ name: "Jan Kowalski", amount: 10 }] });
    expect(r.pack && "entries" in r.pack).toBe(false);
  });
});

describe("P8 stage 7 — UA moves to a pack without behaviour change", () => {
  it("carries the same words, operations, channels, starting set and MCC", () => {
    expect(UA_PACK.typeWords.map((w) => w.word)).toEqual(DEFAULT_TYPE_WORDS.map((w) => w.word));
    expect(UA_PACK.bankOperations).toEqual([...DEFAULT_BANK_OPERATIONS]);
    expect(UA_PACK.channels).toEqual([...PAYMENT_CHANNELS]);
    expect(UA_PACK.merchantTypes?.map((g) => g.code)).toEqual(DEFAULT_MERCHANT_TYPES.map((g) => g.code));
    expect(UA_PACK.idTypes).toEqual(["ua_ipn", "ua_edrpou", "iban", "card_last4"]);
    expect(BUILTIN_PACKS.map((p) => p.id)).toEqual(["ua", "eu"]);
  });

  it("the vocabulary with no packs on equals the old default one", () => {
    expect(packVocabulary(activePacks())).toEqual({ typeWords: [], bankOperations: [] });
    expect(vocabularyOf({ typeWordsExtra: [], typeWordsOff: [], bankOpsExtra: [], bankOpsOff: [] })).toEqual(buildVocabulary());
  });

  it("the EU pack is off until turned on, then adds its words", () => {
    expect(activePacks().map((p) => p.id)).toEqual(["ua"]);
    const v = vocabularyOf({ typeWordsExtra: [], typeWordsOff: [], bankOpsExtra: [], bankOpsOff: [], packs: ["eu"] });
    expect(brandCoreOfKey(payeeMatchKey("Apotheke am Markt"), v).hint?.code).toBe("pharmacy");
  });

  it("existing ІПН / ЄДРПОУ map onto the registry without loss", () => {
    expect(KIND_TO_ID_TYPE).toEqual({ tax_id: "ua_ipn", edrpou: "ua_edrpou", iban: "iban", card_last4: "card_last4" });
    for (const id of Object.values(KIND_TO_ID_TYPE)) expect(idType(id)).toBeTruthy();
    expect(idType("ua_ipn")?.person).toBe(true);
    expect(idType("ua_edrpou")?.person).toBe(false);
  });
});

describe("P8 stage 7 — ID registry validators", () => {
  const ok = (id: string, v: string) => idType(id)!.validate(v).ok;
  it("knows every type the brief names", () => {
    expect(ID_TYPES.map((t) => t.id)).toEqual(["ua_ipn", "ua_edrpou", "pl_nip", "pl_regon", "de_ustid", "eu_vat", "us_ein", "gb_vat", "gb_utr", "iban", "card_last4"]);
  });
  it("UA", () => {
    expect(ok("ua_edrpou", "00032129")).toBe(true);
    expect(ok("ua_edrpou", "00032128")).toBe(false);
    expect(idType("ua_ipn")!.validate("12345").reason).toBe("format");
    expect(idType("ua_ipn")!.mask("1234567890")).toBe("••••••890");
  });
  it("PL", () => {
    expect(ok("pl_nip", "PL 526-104-08-28")).toBe(true);
    expect(ok("pl_regon", "123456785")).toBe(true);
    expect(ok("pl_regon", "123456786")).toBe(false);
  });
  it("DE, EU VAT", () => {
    expect(ok("de_ustid", "DE136695976")).toBe(true);
    expect(ok("de_ustid", "DE136695977")).toBe(false);
    expect(ok("eu_vat", "PL5261040828")).toBe(true);
    expect(idType("eu_vat")!.validate("PL5261040829").reason).toBe("checksum");
    expect(ok("eu_vat", "FR40303265045")).toBe(true);
    expect(idType("eu_vat")!.validate("ZZ123").reason).toBe("format");
  });
  it("US, GB", () => {
    expect(ok("us_ein", "12-3456789")).toBe(true);
    expect(ok("us_ein", "00-3456789")).toBe(false);
    expect(ok("gb_vat", "GB980780684")).toBe(true);
    expect(ok("gb_vat", "GB980780685")).toBe(false);
    expect(ok("gb_utr", "1234567890")).toBe(false);
    expect(idType("gb_utr")?.person).toBe(true);
  });
  it("IBAN mod-97 and card last4", () => {
    expect(ok("iban", "GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ok("iban", "GB82WEST12345698765433")).toBe(false);
    expect(idType("iban")!.mask("GB82WEST12345698765432")).toBe("GB82…5432");
    expect(ok("card_last4", "1234")).toBe(true);
    expect(ok("card_last4", "123")).toBe(false);
    expect(idType("card_last4")!.mask("1234")).toBe("•••• 1234");
  });
});

describe("P8 stage 7 — transliteration plugins", () => {
  it("the matching chain is the old Ukrainian table, unchanged", () => {
    expect(MATCHING_CHAIN).toEqual(["cyrl-uk"]);
    expect(transliterate("сільпо")).toBe("silpo");
    expect(transliterate("щука ґанок")).toBe("shchuka ganok");
    expect(payeeMatchKey("Сільпо")).toBe(payeeMatchKey("Silpo"));
    expect(CYRILLIC_UK.script).toBe("Cyrl");
  });
  it("another script is a plugin, outside the matching chain", () => {
    expect(GREEK_EL.toLatin("αθήνα")).toBe("athina");
    expect(transliterate("αθήνα")).toBe("αθήνα");
    expect(transliterate("αθήνα", ["grek-el"])).toBe("athina");
    registerTranslit({ id: "test-x", script: "Zzzz", detect: /q/, toLatin: (s) => s.replace(/q/g, "k") });
    expect(translitPlugin("test-x")).toBeTruthy();
    expect(transliterate("qq", ["test-x"])).toBe("kk");
  });
});

describe("P8 stage 7 — dictionary v2", () => {
  it("adds locale and country, keeps reading v1", () => {
    const d = buildDictionary([], new Date("2026-10-14T00:00:00Z"), [], { locale: "uk", country: "UA" });
    expect(d).toMatchObject({ version: DICTIONARY_VERSION, locale: "uk", country: "UA" });
    expect(DICTIONARY_VERSION).toBe(2);
    expect(JSON.parse(dictionaryToJson(d))).toMatchObject({ version: 2, locale: "uk", country: "UA" });
    expect(parseDictionary('{"format":"finlynq-payee-dictionary","version":1,"entries":[]}').entries).toEqual([]);
    expect(parseDictionary('{"format":"finlynq-payee-dictionary","version":2,"locale":"pl","country":"PL","entries":[]}').entries).toEqual([]);
  });
});
