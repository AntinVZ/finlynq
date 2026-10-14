/**
 * Country packs (P8 stage 7): what is country- or language-specific about
 * payees, as DATA — type words (with the merchant type they suggest), the
 * bank's own operations, payment channels, the merchant-type starting set,
 * MCC codes, the ID types the country uses (./id-registry) and the
 * transliteration it needs (./translit). A new country is one pack file (or
 * a JSON the person imports in «Словники і пакети»), no code.
 *
 * Packs stack: UA (the built-in behaviour, always on) → the built-in packs
 * the person turns on → their imported packs → their own words in the
 * Studio settings on top. A pack never carries personal data: no names of
 * people, amounts, dates or notes — the format has no place for them.
 *
 * Format (JSON):
 *   { format: "finlynq-country-pack", version: 1, id, country, locale, name,
 *     typeWords: [{ word, type? }], bankOperations: [..], channels: [..],
 *     merchantTypes?: [{ group, code, names?: [{ name, code }] }],
 *     mcc?: { "5812": "restaurant" }, idTypes: ["pl_nip", ..],
 *     transliteration?: ["cyrl-uk"] }
 * `type` / mcc values are merchant-type codes (`cafe`, `fuel`, …).
 */
import { z } from "zod";
import { DEFAULT_BANK_OPERATIONS, DEFAULT_TYPE_WORDS, PAYMENT_CHANNELS, type MerchantTypeHint } from "../type-words";
import { DEFAULT_MERCHANT_TYPES, defaultMerchantTypeByCode, defaultMerchantTypeCode, MCC_TYPES } from "../merchant-types";
import { ID_TYPES } from "../id-registry";
import { translitPlugin } from "../translit";
import { EU_PACK } from "./eu";

export const PACK_FORMAT = "finlynq-country-pack";
export const PACK_VERSION = 1;
export const PACK_MAX_WORDS = 2_000;
export const CUSTOM_PACKS_MAX = 5;

const code = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/);
const text60 = z.string().trim().min(1).max(60);
export const countryPackSchema = z.object({
  format: z.literal(PACK_FORMAT),
  version: z.literal(PACK_VERSION),
  id: z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/),
  country: z.string().trim().regex(/^([A-Z]{2}|EU|\*)$/),
  locale: z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
  name: z.string().trim().min(1).max(80),
  typeWords: z.array(z.object({ word: text60, type: code.optional() })).max(PACK_MAX_WORDS).default([]),
  bankOperations: z.array(text60).max(PACK_MAX_WORDS).default([]),
  channels: z.array(z.string().trim().min(2).max(30)).max(100).default([]),
  merchantTypes: z
    .array(z.object({ group: z.string().trim().min(1).max(80), code, names: z.array(z.object({ name: z.string().trim().min(1).max(80), code })).max(50).optional() }))
    .max(100)
    .optional(),
  mcc: z.record(z.string().regex(/^\d{4}$/), code).optional(),
  idTypes: z.array(z.string().max(40)).max(50).default([]),
  transliteration: z.array(z.string().max(40)).max(10).optional(),
});
export type CountryPack = z.infer<typeof countryPackSchema>;

/** UA — the behaviour Finlynq always had, expressed as a pack (same words, same order). */
export const UA_PACK: CountryPack = {
  format: PACK_FORMAT,
  version: PACK_VERSION,
  id: "ua",
  country: "UA",
  locale: "uk",
  name: "Україна",
  typeWords: DEFAULT_TYPE_WORDS.map((w) => ({ word: w.word, ...(w.hint ? { type: w.hint.code ?? defaultMerchantTypeCode(w.hint) ?? undefined } : {}) })),
  bankOperations: [...DEFAULT_BANK_OPERATIONS],
  channels: [...PAYMENT_CHANNELS],
  merchantTypes: DEFAULT_MERCHANT_TYPES.map((g) => ({ group: g.group, code: g.code, ...(g.names ? { names: g.names.map((n) => ({ name: n.name, code: n.code })) } : {}) })),
  mcc: Object.fromEntries(Object.entries(MCC_TYPES).map(([mcc, t]) => [mcc, t.code])),
  idTypes: ["ua_ipn", "ua_edrpou", "iban", "card_last4"],
  transliteration: ["cyrl-uk"],
};

/** Built-in packs; UA is always on, the rest are switched on by the person. */
export const BUILTIN_PACKS: readonly CountryPack[] = [UA_PACK, EU_PACK];

export type PackError = { path: string; message: string };

/** Validate an imported pack (JSON text or object). */
export function parsePack(input: unknown): { pack: CountryPack | null; errors: PackError[] } {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return { pack: null, errors: [{ path: "", message: "Not JSON" }] };
    }
  }
  const r = countryPackSchema.safeParse(raw);
  if (!r.success) return { pack: null, errors: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) };
  if (BUILTIN_PACKS.some((p) => p.id === r.data.id)) return { pack: null, errors: [{ path: "id", message: `"${r.data.id}" is a built-in pack` }] };
  return { pack: r.data, errors: [] };
}

/** The packs in force for a person, in stacking order. */
export function activePacks(opts: { packs?: readonly string[]; customPacks?: readonly CountryPack[] } = {}): CountryPack[] {
  const on = new Set(opts.packs ?? []);
  return [UA_PACK, ...BUILTIN_PACKS.filter((p) => p.id !== "ua" && on.has(p.id)), ...(opts.customPacks ?? [])];
}

/** A merchant-type hint for a pack's type code (null for an unknown code: the word still counts as a type word). */
export function hintOfCode(c: string | undefined): MerchantTypeHint | null {
  if (!c) return null;
  const d = defaultMerchantTypeByCode(c);
  return d ? { group: d.group, name: d.name, code: d.code } : null;
}

/** What the vocabulary takes from packs beyond UA (UA's own words are the built-in defaults). */
export function packVocabulary(packs: readonly CountryPack[]): { typeWords: Array<{ word: string; hint: MerchantTypeHint | null }>; bankOperations: string[] } {
  const extra = packs.filter((p) => p.id !== "ua");
  return {
    typeWords: extra.flatMap((p) => p.typeWords.map((w) => ({ word: w.word, hint: hintOfCode(w.type) }))),
    bankOperations: extra.flatMap((p) => p.bankOperations),
  };
}

/** The ID types the active packs use (registry ids, no duplicates). */
export function packIdTypes(packs: readonly CountryPack[]): string[] {
  return [...new Set(packs.flatMap((p) => p.idTypes))];
}

export type PackSummary = {
  id: string;
  name: string;
  country: string;
  locale: string;
  builtin: boolean;
  typeWords: number;
  bankOperations: number;
  channels: number;
  merchantTypes: number;
  mcc: number;
  idTypes: Array<{ id: string; label: string; known: boolean }>;
  transliteration: Array<{ id: string; available: boolean }>;
  /** Type words whose merchant type is not a known code (they still count as type words). */
  unknownTypeCodes: string[];
};

export function summarizePack(p: CountryPack): PackSummary {
  const unknown = new Set<string>();
  for (const w of p.typeWords) if (w.type && !defaultMerchantTypeByCode(w.type)) unknown.add(w.type);
  return {
    id: p.id,
    name: p.name,
    country: p.country,
    locale: p.locale,
    builtin: BUILTIN_PACKS.some((b) => b.id === p.id),
    typeWords: p.typeWords.length,
    bankOperations: p.bankOperations.length,
    channels: p.channels.length,
    merchantTypes: (p.merchantTypes ?? []).reduce((n, g) => n + (g.names?.length ?? 1), 0),
    mcc: Object.keys(p.mcc ?? {}).length,
    idTypes: p.idTypes.map((id) => ({ id, label: ID_TYPES.find((t) => t.id === id)?.label ?? id, known: ID_TYPES.some((t) => t.id === id) })),
    transliteration: (p.transliteration ?? []).map((id) => ({ id, available: translitPlugin(id) != null })),
    unknownTypeCodes: [...unknown],
  };
}
