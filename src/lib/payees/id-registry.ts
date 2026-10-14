/**
 * The registry of requisite / ID types (P8 stage 7): what a value is, how
 * it is checked, how it is shown, and whether it belongs to a private person.
 * A country pack (./packs) lists the ID types it uses by `id`, so a new
 * country needs data only — as long as its IDs are here. A failed check digit
 * is reported, never silently accepted.
 *
 * The directory's stored kinds map onto it without loss: `tax_id` → ua_ipn,
 * `edrpou` → ua_edrpou, `iban` → iban, `card_last4` → card_last4
 * (`crypto_wallet` stays outside: it is not an identity number).
 *
 * Pure (web and server).
 */
import { edrpouChecksumOk, ibanChecksumOk, rnokppChecksumOk } from "./requisites";

export type IdCheck = { ok: boolean; normalized: string; reason?: "format" | "checksum" };

export type IdType = {
  id: string;
  /** ISO country, or "EU" / "*" for types used everywhere. */
  country: string;
  /** Short name as people write it (not translated: ІПН, NIP, EIN…). */
  label: string;
  /** A private person's number — masked and never shared in a dictionary. */
  person: boolean;
  /** A shape for the input field, e.g. "0000000000" or "DE000000000". */
  example: string;
  validate: (raw: string) => IdCheck;
  mask: (normalized: string) => string;
};

const digits = (raw: string) => raw.replace(/[\s.\-/]/g, "");
const upperAlnum = (raw: string) => raw.replace(/[\s.\-/]/g, "").toUpperCase();
const isDigits = (s: string, n: number | number[]) => /^\d+$/.test(s) && (Array.isArray(n) ? n.includes(s.length) : s.length === n);
const weighted = (s: string, w: readonly number[]) => w.reduce((sum, wi, i) => sum + wi * Number(s[i]), 0);
const result = (normalized: string, format: boolean, checksum: boolean): IdCheck =>
  !format ? { ok: false, normalized, reason: "format" } : !checksum ? { ok: false, normalized, reason: "checksum" } : { ok: true, normalized };

/** Person numbers: only the last 3 digits are shown. */
const maskPerson = (v: string) => (v.length <= 3 ? "•••" : `${"•".repeat(Math.min(6, v.length - 3))}${v.slice(-3)}`);
/** Public business numbers are shown as they are. */
const maskNone = (v: string) => v;

// ── Poland ────────────────────────────────────────────────────────────────
export function plNipOk(v: string): boolean {
  if (!isDigits(v, 10)) return false;
  const c = weighted(v, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
  return c !== 10 && c === Number(v[9]);
}
export function plRegonOk(v: string): boolean {
  if (isDigits(v, 9)) {
    const c = weighted(v, [8, 9, 2, 3, 4, 5, 6, 7]) % 11;
    return (c === 10 ? 0 : c) === Number(v[8]);
  }
  if (isDigits(v, 14)) {
    const c = weighted(v, [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8]) % 11;
    return (c === 10 ? 0 : c) === Number(v[13]) && plRegonOk(v.slice(0, 9));
  }
  return false;
}

// ── Germany: USt-IdNr, ISO 7064 MOD 11,10 ──────────────────────────────────
export function deUstIdOk(v: string): boolean {
  const n = v.startsWith("DE") ? v.slice(2) : v;
  if (!isDigits(n, 9)) return false;
  let product = 10;
  for (let i = 0; i < 8; i++) {
    let sum = (Number(n[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === Number(n[8]);
}

// ── United States: EIN (no check digit; the prefix must be one the IRS issues) ─
const EIN_BAD_PREFIX = new Set(["00", "07", "08", "09", "17", "18", "19", "28", "29", "49", "69", "70", "78", "79", "89", "96", "97"]);
export function usEinOk(v: string): boolean {
  return isDigits(v, 9) && !EIN_BAD_PREFIX.has(v.slice(0, 2));
}

// ── United Kingdom: VAT (mod 97, old and new scheme) and UTR (mod 11) ──────
export function gbVatOk(v: string): boolean {
  const n = v.startsWith("GB") ? v.slice(2) : v;
  if (/^(GD|HA)\d{3}$/.test(n)) return true; // government departments / health authorities
  if (!isDigits(n, [9, 12])) return false;
  const total = weighted(n, [8, 7, 6, 5, 4, 3, 2]) + Number(n.slice(7, 9));
  return total % 97 === 0 || (total + 55) % 97 === 0;
}
export function gbUtrOk(v: string): boolean {
  const n = v.replace(/K$/i, "");
  if (!isDigits(n, 10)) return false;
  const r = weighted(n.slice(1), [6, 7, 8, 9, 10, 5, 4, 3, 2]) % 11;
  return [2, 1, 9, 8, 7, 6, 5, 4, 3, 2, 1][r] === Number(n[0]);
}

// ── EU VAT: a member-state prefix + its national format ─────────────────────
const EU_VAT_SHAPE: Record<string, RegExp> = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/, DE: /^\d{9}$/, DK: /^\d{8}$/,
  EE: /^\d{9}$/, EL: /^\d{9}$/, ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^\d{8}$/, FR: /^[A-Z0-9]{2}\d{9}$/, HR: /^\d{11}$/,
  HU: /^\d{8}$/, IE: /^\d{7}[A-Z]{1,2}$|^\d[A-Z+*]\d{5}[A-Z]$/, IT: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/, LU: /^\d{8}$/,
  LV: /^\d{11}$/, MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/, RO: /^\d{2,10}$/, SE: /^\d{12}$/,
  SI: /^\d{8}$/, SK: /^\d{10}$/, XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};
export function euVatCheck(raw: string): IdCheck {
  const v = upperAlnum(raw);
  const cc = v.slice(0, 2);
  const shape = EU_VAT_SHAPE[cc];
  const rest = v.slice(2);
  if (!shape || !shape.test(rest)) return { ok: false, normalized: v, reason: "format" };
  // Where the national check digit is known, it is checked too.
  if (cc === "PL" && !plNipOk(rest)) return { ok: false, normalized: v, reason: "checksum" };
  if (cc === "DE" && !deUstIdOk(rest)) return { ok: false, normalized: v, reason: "checksum" };
  if (cc === "XI" && /^\d/.test(rest) && !gbVatOk(rest)) return { ok: false, normalized: v, reason: "checksum" };
  return { ok: true, normalized: v };
}

export const ID_TYPES: readonly IdType[] = [
  {
    id: "ua_ipn", country: "UA", label: "ІПН / РНОКПП", person: true, example: "0000000000",
    validate: (raw) => { const v = digits(raw); return result(v, isDigits(v, 10), rnokppChecksumOk(v)); },
    mask: maskPerson,
  },
  {
    id: "ua_edrpou", country: "UA", label: "ЄДРПОУ", person: false, example: "00000000",
    validate: (raw) => { const v = digits(raw); return result(v, isDigits(v, 8), edrpouChecksumOk(v)); },
    mask: maskNone,
  },
  {
    id: "pl_nip", country: "PL", label: "NIP", person: false, example: "000-000-00-00",
    validate: (raw) => { const v = digits(upperAlnum(raw).replace(/^PL/, "")); return result(v, isDigits(v, 10), plNipOk(v)); },
    mask: maskNone,
  },
  {
    id: "pl_regon", country: "PL", label: "REGON", person: false, example: "000000000",
    validate: (raw) => { const v = digits(raw); return result(v, isDigits(v, [9, 14]), plRegonOk(v)); },
    mask: maskNone,
  },
  {
    id: "de_ustid", country: "DE", label: "USt-IdNr.", person: false, example: "DE000000000",
    validate: (raw) => { const v = upperAlnum(raw); const n = v.replace(/^DE/, ""); return result(`DE${n}`, isDigits(n, 9), deUstIdOk(n)); },
    mask: maskNone,
  },
  { id: "eu_vat", country: "EU", label: "VAT", person: false, example: "PL0000000000", validate: euVatCheck, mask: maskNone },
  {
    id: "us_ein", country: "US", label: "EIN", person: false, example: "00-0000000",
    validate: (raw) => { const v = digits(raw); return result(v, isDigits(v, 9), usEinOk(v)); },
    mask: maskNone,
  },
  {
    id: "gb_vat", country: "GB", label: "VAT", person: false, example: "GB000000000",
    validate: (raw) => { const v = upperAlnum(raw); const n = v.replace(/^GB/, ""); return result(`GB${n}`, /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/.test(n), gbVatOk(n)); },
    mask: maskNone,
  },
  {
    // A UTR belongs to a person or a business; treated as personal to be safe.
    id: "gb_utr", country: "GB", label: "UTR", person: true, example: "0000000000",
    validate: (raw) => { const v = upperAlnum(raw).replace(/K$/, ""); return result(v, isDigits(v, 10), gbUtrOk(v)); },
    mask: maskPerson,
  },
  {
    id: "iban", country: "*", label: "IBAN", person: false, example: "UA000000000000000000000000000",
    validate: (raw) => { const v = upperAlnum(raw); return result(v, /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v), ibanChecksumOk(v)); },
    mask: (v) => (v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v),
  },
  {
    id: "card_last4", country: "*", label: "•••• 0000", person: false, example: "0000",
    validate: (raw) => { const v = digits(raw).slice(-4); return result(v, isDigits(v, 4) && digits(raw).length <= 4, true); },
    mask: (v) => `•••• ${v}`,
  },
];

const BY_ID = new Map(ID_TYPES.map((t) => [t.id, t]));

export function idType(id: string): IdType | undefined {
  return BY_ID.get(id);
}

/** The directory's stored identifier kinds, as registry types (no data changes). */
export const KIND_TO_ID_TYPE: Readonly<Record<string, string>> = { tax_id: "ua_ipn", edrpou: "ua_edrpou", iban: "iban", card_last4: "card_last4" };

/**
 * Which of the given ID types a value is (checked, with the check digit).
 * `ids` usually comes from the active country packs. Values that pass the
 * format but fail the check digit are listed with `ok: false`.
 */
export function detectIdTypes(raw: string, ids: readonly string[]): Array<{ id: string; label: string; country: string; person: boolean; check: IdCheck; masked: string }> {
  const out: Array<{ id: string; label: string; country: string; person: boolean; check: IdCheck; masked: string }> = [];
  for (const id of ids) {
    const t = BY_ID.get(id);
    if (!t) continue;
    const check = t.validate(raw);
    if (check.reason === "format") continue;
    out.push({ id: t.id, label: t.label, country: t.country, person: t.person, check, masked: t.mask(check.normalized) });
  }
  return out.sort((a, b) => Number(b.check.ok) - Number(a.check.ok));
}
