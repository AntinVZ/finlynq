/**
 * Text normalization for MATCHING user input against stored text.
 *
 * `toLowerCase()` alone is not enough for real-world data: the same word can
 * arrive with a typographic apostrophe (`здоров’я`) or an ASCII one
 * (`здоров'я`), as precomposed or decomposed Unicode (`й` vs `и` + U+0306),
 * with an en dash instead of a hyphen, a non-breaking space, or an invisible
 * zero-width character pasted from a bank statement. `normalizeForMatch`
 * folds all of those to one form so filters, rules and name resolvers agree.
 *
 * Comparison only — never use this to rewrite stored text, and never use it
 * for the Stream D `name_lookup` HMAC (that normalization is persisted and
 * indexed; see `nameLookupCandidates` in crypto/encrypted-columns.ts).
 *
 * Deliberately NOT done: Latin ↔ Cyrillic homoglyph folding (`C` vs `С`),
 * diacritic stripping (`ї` stays `ї`), or locale-aware lowercasing.
 */

/** ASCII ', right/left single quote, modifier-letter apostrophe, grave, acute. */
const APOSTROPHES_RE = /['\u2019\u02BC\u2018`\u00B4]/g;
/** Unicode hyphens/dashes (U+2010–U+2015) and the minus sign (U+2212). */
const DASHES_RE = /[\u2010-\u2015\u2212]/g;
/** Zero-width space / non-joiner / joiner and the BOM / zero-width no-break space. */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
/** Fast path: printable ASCII words joined by single spaces, no apostrophe/backtick — nothing to fold but case. */
const PLAIN_ASCII_RE = /^(?:[\x21-\x26\x28-\x5F\x61-\x7E]+(?: [\x21-\x26\x28-\x5F\x61-\x7E]+)*)?$/;

/**
 * Strings made only of these code points are already NFC and cannot compose
 * (no combining marks, no singleton decompositions, no composition second
 * parts — checked against Unicode 15.1): ASCII + Latin-1 + Latin Extended,
 * IPA/spacing modifiers, Cyrillic (minus combining U+0483–U+0489), general
 * punctuation (minus the U+2000/U+2001 singletons), currency, №, arrows, math.
 */
const NFC_STABLE_RE = /^[\x00-\u02FF\u0400-\u0482\u048A-\u052F\u2002-\u206F\u20A0-\u20C0\u2116\u2190-\u22FF]*$/;
/** Anything left to fold after lowercasing: apostrophes, dashes, zero-width, non-single-space whitespace, edge spaces. */
const NEEDS_FOLD_RE = /[\u2019\u02BC\u2018\u0060\u00B4\u2010-\u2015\u2212\u200B-\u200D\uFEFF]|\s\s|[^\S ]|^\s|\s$/;

/** Every apostrophe variant `normalizeForMatch` folds to ASCII `'`. */
export const APOSTROPHE_VARIANTS = ["'", "\u2019", "\u02BC", "\u2018", "`", "\u00B4"] as const;

/**
 * Fold `s` to its comparison form: zero-width characters removed, NFC,
 * `toLowerCase()`, every apostrophe → `'`, every dash/minus → `-`, whitespace
 * runs (incl. NBSP) → one space, trimmed.
 */
export function normalizeForMatch(s: string): string {
  // Hot path for filters over ~20k rows: most ASCII values only need lowercasing.
  if (PLAIN_ASCII_RE.test(s)) return s.toLowerCase();
  let t = s;
  // Zero-width chars go before NFC: one between a base letter and its
  // combining mark would otherwise block composition.
  if (!NFC_STABLE_RE.test(t)) t = t.replace(ZERO_WIDTH_RE, "").normalize("NFC");
  t = t.toLowerCase();
  if (!NEEDS_FOLD_RE.test(t)) return t;
  return t
    .replace(ZERO_WIDTH_RE, "")
    .replace(APOSTROPHES_RE, "'")
    .replace(DASHES_RE, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Substring test on normalized text. A null/absent haystack never matches.
 * For loops, normalize the needle once and use {@link containsNormalizedNeedle}.
 */
export function containsNormalized(haystack: unknown, needle: string): boolean {
  return containsNormalizedNeedle(haystack, normalizeForMatch(needle));
}

/** Like {@link containsNormalized} but `needle` is already normalized. */
export function containsNormalizedNeedle(haystack: unknown, normalizedNeedle: string): boolean {
  if (haystack == null) return false;
  return normalizeForMatch(String(haystack)).includes(normalizedNeedle);
}

/** Equality on normalized text. Null/absent never equals anything. */
export function equalsNormalized(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return normalizeForMatch(String(a)) === normalizeForMatch(String(b));
}
