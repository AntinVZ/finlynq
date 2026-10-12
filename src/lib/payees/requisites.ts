/**
 * Counterparty requisites in text (Payee Studio P5f / P5g): Ukrainian IBANs,
 * card masks, signed tax codes; their check digits; privacy masking.
 *
 * Recognized in free text (payee, note, bank-statement text):
 *   - IBAN: `UA` + 27 digits (spaces allowed), checked with ISO 13616 mod-97;
 *   - card masks: `**** 1234`, `*1234`, `5168 **** **** 1234`,
 *     `516874******1234`, `4149xx1234` — only the LAST 4 digits are kept;
 *   - a full card number (16 digits, or 13–19 digits passing Luhn) — only its
 *     last 4 digits are kept, the rest is never returned, logged or stored;
 *   - SIGNED codes only: `ЄДРПОУ 12345678`, `код ЄДРПОУ: 12345678`,
 *     `ІПН 1234567890`, `РНОКПП …`, `ІН …`, `ИНН …`. A bare 8- or 10-digit
 *     number is never taken for a code.
 *
 * Check digits (a failure is a WARNING — "looks like a typo" — never a refusal):
 *   - РНОКПП / ІПН (10 digits): weights −1 5 7 9 4 6 10 5 7 over the first 9
 *     digits, sum mod 11 mod 10 = the 10th digit;
 *   - ЄДРПОУ (8 digits): weights 1…7, or 7 1 2 3 4 5 6 for codes from
 *     30 000 000 to 60 000 000; when the sum mod 11 is 10, the weights + 2
 *     are used; a second 10 counts as 0; the result is the 8th digit.
 *
 * Pure: no DB, no network.
 */

export type RequisiteKind = "iban" | "card_last4" | "tax_id" | "edrpou";

export type FoundRequisite = {
  kind: RequisiteKind;
  /** Normalized value: IBAN without spaces, card LAST 4 only, code digits. */
  value: string;
  /** Safe to show / log. */
  masked: string;
  /** IBAN mod-97 / tax-code check digits pass. Card masks: true. */
  valid: boolean;
  /** How it was found. */
  via: "iban" | "card_mask" | "card_full" | "signed_code";
};

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** РНОКПП / ІПН check digit. */
export function rnokppChecksumOk(code: string): boolean {
  if (!/^\d{10}$/.test(code)) return false;
  const w = [-1, 5, 7, 9, 4, 6, 10, 5, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(code[i]) * w[i];
  return ((sum % 11) + 11) % 11 % 10 === Number(code[9]);
}

/** ЄДРПОУ check digit (the registry's two weight sets, with the +2 retry). */
export function edrpouChecksumOk(code: string): boolean {
  if (!/^\d{8}$/.test(code)) return false;
  const n = Number(code);
  const base = n < 30_000_000 || n > 60_000_000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
  const calc = (weights: number[]) => weights.reduce((s, w, i) => s + w * Number(code[i]), 0) % 11;
  let c = calc(base);
  if (c === 10) {
    c = calc(base.map((w) => w + 2));
    if (c === 10) c = 0;
  }
  return c === Number(code[7]);
}

/** ISO 13616 IBAN check (mod 97 = 1). */
export function ibanChecksumOk(iban: string): boolean {
  const v = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(v)) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const d = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const x of d) rem = (rem * 10 + Number(x)) % 97;
  }
  return rem === 1;
}

/** Luhn check for a full card number. */
export function luhnOk(pan: string): boolean {
  if (!/^\d{13,19}$/.test(pan)) return false;
  let sum = 0;
  for (let i = 0; i < pan.length; i++) {
    let d = Number(pan[pan.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function maskIban(iban: string): string {
  return iban.length > 8 ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : "••••";
}

const IBAN_RE = /\bUA\s?\d{2}(?:\s?\d){25}\b/gi;
// First 4–6 digits (optional), then a run of mask characters, then the last 4.
const CARD_MASK_RE = /(?<![\d*xX•])(?:\d{4,6}[\s-]?)?(?:[*xX•]{2,}[\s-]?)+(?:\d{4}[\s-]?)?(?:[*xX•]{2,}[\s-]?)*(\d{4})(?!\d)/g;
// `*1234` — a single star right before the last 4 digits.
const CARD_STAR_RE = /(?<![\p{L}\d*])\*(\d{4})(?!\d)/gu;
const FULL_PAN_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const SIGNED_EDRPOU_RE = /(?<![\p{L}])(?:код\s+)?(?:ЄДРПОУ|ЕДРПОУ|EDRPOU|USREOU)(?:\s+код)?\s*[:№#-]?\s*(\d{8})(?!\d)/giu;
const SIGNED_TAX_RE = /(?<![\p{L}])(?:ІПН|РНОКПП|ІН|ИНН|IPN|RNOKPP|ДРФО)\s*[:№#-]?\s*(\d{10})(?!\d)/giu;

/** Every requisite in a text, de-duplicated. Card numbers come back as their last 4 digits only. */
export function extractRequisites(text: string | null | undefined): FoundRequisite[] {
  const s = String(text ?? "");
  if (!s.trim()) return [];
  const out: FoundRequisite[] = [];
  const seen = new Set<string>();
  const push = (r: FoundRequisite) => {
    const k = `${r.kind}:${r.value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };
  const ibanSpans: Array<[number, number]> = [];
  for (const m of s.matchAll(IBAN_RE)) {
    const v = m[0].replace(/\s+/g, "").toUpperCase();
    ibanSpans.push([m.index!, m.index! + m[0].length]);
    push({ kind: "iban", value: v, masked: maskIban(v), valid: ibanChecksumOk(v), via: "iban" });
  }
  const inIban = (i: number) => ibanSpans.some(([a, b]) => i >= a && i < b);
  for (const m of s.matchAll(SIGNED_EDRPOU_RE)) push({ kind: "edrpou", value: m[1], masked: m[1], valid: edrpouChecksumOk(m[1]), via: "signed_code" });
  for (const m of s.matchAll(SIGNED_TAX_RE)) push({ kind: "tax_id", value: m[1], masked: `••••••••${m[1].slice(-2)}`, valid: rnokppChecksumOk(m[1]), via: "signed_code" });
  for (const m of s.matchAll(CARD_MASK_RE)) {
    if (inIban(m.index!)) continue;
    push({ kind: "card_last4", value: m[1], masked: `•••• ${m[1]}`, valid: true, via: "card_mask" });
  }
  for (const m of s.matchAll(CARD_STAR_RE)) push({ kind: "card_last4", value: m[1], masked: `•••• ${m[1]}`, valid: true, via: "card_mask" });
  for (const m of s.matchAll(FULL_PAN_RE)) {
    if (inIban(m.index!)) continue;
    const pan = digitsOf(m[0]);
    if (pan.length < 13 || pan.length > 19 || (pan.length !== 16 && !luhnOk(pan))) continue;
    push({ kind: "card_last4", value: pan.slice(-4), masked: `•••• ${pan.slice(-4)}`, valid: true, via: "card_full" });
  }
  return out;
}

/**
 * The text with every IBAN and every 13–19-digit run (a possible card number,
 * Luhn or not) masked, safe to show as an example row (`5168 7420 1234 5678`
 * → `•••• 5678`). Signed tax codes of people are masked too; EDRPOU (public)
 * stays.
 */
export function maskSensitiveText(text: string | null | undefined): string {
  let s = String(text ?? "");
  s = s.replace(IBAN_RE, (m) => maskIban(m.replace(/\s+/g, "").toUpperCase()));
  s = s.replace(FULL_PAN_RE, (m) => {
    const pan = digitsOf(m);
    return pan.length >= 13 && pan.length <= 19 ? `•••• ${pan.slice(-4)}` : m;
  });
  s = s.replace(SIGNED_TAX_RE, (m, code: string) => m.replace(code, `••••••••${code.slice(-2)}`));
  return s;
}

/** What kind of counterparty a code suggests: 8 digits → legal entity, 10 → person / ФОП. */
export function typeHintForCode(code: string): "company" | "person_or_sole_proprietor" | null {
  const d = digitsOf(code);
  if (d.length === 8) return "company";
  if (d.length === 10) return "person_or_sole_proprietor";
  return null;
}

/** The one refusal for a full card number, wherever it is typed (P6.2: never accepted, never stored). */
export const FULL_CARD_REFUSAL = "Повний номер картки не приймається: вкажіть лише останні 4 цифри (або маску «**** 1234»).";

/**
 * Is this card input a full card number? 13+ digits in all (a mask keeps at
 * most 6 + 4), or a run of 12+ digits (spaces / dashes allowed between
 * them). `strict` (a card field): also more than 4 digits with no mask
 * character — only the last 4 or a mask is accepted there.
 */
export function isFullCardNumber(raw: string, opts: { strict?: boolean } = {}): boolean {
  const s = String(raw ?? "");
  const digits = digitsOf(s);
  if (digits.length >= 13) return true;
  if (/(?<!\d)(?:\d[ -]?){11,}\d(?!\d)/.test(s)) return true;
  return Boolean(opts.strict) && !/[*xX•]/.test(s) && digits.length > 4;
}

/** Why a requisite query is refused (a full card number), or null. IBANs and codes are not cards. */
export function identifierQueryRefusal(raw: string): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const compact = t.replace(/[\s-]+/g, "").toUpperCase();
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return null; // an IBAN
  return isFullCardNumber(t) ? FULL_CARD_REFUSAL : null;
}

export type IdentifierQuery =
  | { kind: "iban"; value: string; masked: string; strong: true }
  | { kind: "card_last4"; value: string; masked: string; strong: false }
  | { kind: "tax_id"; value: string; masked: string; strong: true }
  | { kind: "edrpou"; value: string; masked: string; strong: true };

/**
 * Understand what someone typed as a requisite: an IBAN, a card in any form
 * (`5168 **** 1234`, `****1234`, `1234`), a 10-digit ІПН / РНОКПП or an
 * 8-digit ЄДРПОУ. Spaces, dashes and asterisks are ignored. Null when it is
 * none of these — and for a full card number, which is never accepted
 * (P6.2; callers say why with `identifierQueryRefusal`).
 */
export function parseIdentifierQuery(raw: string): IdentifierQuery | null {
  const t = raw.trim();
  if (!t) return null;
  const compact = t.replace(/[\s-]+/g, "").toUpperCase();
  if (/^UA\d{27}$/.test(compact) || /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(compact)) return { kind: "iban", value: compact, masked: maskIban(compact), strong: true };
  if (identifierQueryRefusal(t)) return null;
  if (/[*X•]/.test(compact) || /^\d{4}$/.test(compact)) {
    const last = compact.match(/(\d{4})$/);
    if (last) return { kind: "card_last4", value: last[1], masked: `•••• ${last[1]}`, strong: false };
    return null;
  }
  const d = digitsOf(t);
  if (d.length !== compact.replace(/[^0-9]/g, "").length || !/^\d+$/.test(compact)) return null;
  if (d.length === 10) return { kind: "tax_id", value: d, masked: `••••••••${d.slice(-2)}`, strong: true };
  if (d.length === 8) return { kind: "edrpou", value: d, masked: d, strong: true };
  return null;
}
