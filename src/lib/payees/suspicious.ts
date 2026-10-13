/**
 * Suspicious directory entries (Payee Studio P6.2, item 83): entries whose
 * name is too short or looks meaningless (`Ma`, `Galia baluvana`) — usually a
 * fragment of a bank's description that became a payee by accident. They are
 * LISTED with a reason for a person to check ("Перевірити"); nothing is ever
 * changed automatically. The person renames, merges, deletes the entry (its
 * rows stay as they are) or marks it as checked (`reviewed_at`), after which
 * it is not listed again.
 *
 * Rules (any one is enough):
 *   - short:     at most 3 letters / digits in the whole name (unless the
 *     entry already has brand signs: a merchant type, website, requisites…);
 *   - no_letters: not a single letter;
 *   - latin_no_brand: one or two Latin words with no brand sign. Brand signs:
 *     a digit, a web domain, a capital inside a word (`PlayStation`), an
 *     ALL-CAPS acronym, a type word or legal form, a merchant type, a website
 *     or logo, requisites, or several spellings (aliases) already confirmed.
 *     The second word of a two-word name starting in lower case
 *     (`Galia baluvana`) reads as a fragment of text, not a brand.
 *
 * Pure: works on a loaded directory and its row counts.
 */
import { payeeMatchKey, payeeTokens } from "./match-key";
import { brandCoreOfKey, defaultVocabulary, type PayeeVocabulary } from "./type-words";
import type { PayeeEntity } from "./directory";
import { st } from "@/lib/i18n/current";

export type SuspicionCode = "short" | "no_letters" | "latin_no_brand";

export type Suspicion = { code: SuspicionCode; reason: string };

const LATIN_WORD = /^[A-Za-z][A-Za-z'’-]*$/;

/** Why a name looks suspicious (empty = it doesn't). `brandSigns` = facts outside the name (type, website, aliases…). */
export function suspiciousReasons(name: string, opts: { brandSigns?: boolean; vocab?: PayeeVocabulary } = {}): Suspicion[] {
  const out: Suspicion[] = [];
  const trimmed = name.replace(/\s+/g, " ").trim();
  const alnum = trimmed.replace(/[^\p{L}\p{N}]/gu, "");
  if (!/\p{L}/u.test(trimmed)) {
    out.push({ code: "no_letters", reason: st("srv.suspicious.noLetters") });
    return out;
  }
  if (opts.brandSigns) return out; // a typed / profiled entry (KFC with a merchant type) is a real brand
  if (alnum.length <= 3) out.push({ code: "short", reason: st("srv.suspicious.short", { n: alnum.length }) });
  const words = trimmed.split(" ");
  if (words.length > 2 || !words.every((w) => LATIN_WORD.test(w))) return out;
  if (/\d/.test(trimmed) || /\.[a-z]{2,4}\b/i.test(trimmed)) return out;
  if (words.some((w) => /[a-z][A-Z]/.test(w))) return out; // PlayStation, eBay
  if (words.some((w) => w.replace(/[^A-Za-z]/g, "").length >= 2 && w === w.toUpperCase())) return out; // ATB, OKKO, WOG Plus
  const tokens = payeeTokens(trimmed);
  if (tokens.legal.length) return out;
  if (brandCoreOfKey(payeeMatchKey(trimmed), opts.vocab ?? defaultVocabulary()).removed.length) return out;
  if (!out.length) {
    const fragment = words.length === 2 && /^[a-z]/.test(words[1]);
    out.push({
      code: "latin_no_brand",
      reason: fragment ? st("srv.suspicious.latinFragment") : st("srv.suspicious.latinWord"),
    });
  }
  return out;
}

export type SuspiciousEntry = {
  id: number;
  name: string;
  reasons: Suspicion[];
  /** Transactions resolving to the entry. */
  count: number;
  /** Its spellings with row counts (most used first). */
  spellings: Array<{ spelling: string; count: number }>;
};

/** Facts outside the name that say the entry is a real brand. */
export function hasBrandSigns(e: PayeeEntity): boolean {
  const confirmedSpellings = e.aliases.filter((a) => a.mode === "exact" && a.source !== "canonical").length;
  return e.merchantTypeId != null || e.website != null || e.logo != null || e.identifiers.length > 0 || confirmedSpellings >= 2;
}

/** Entries to check, most rows first. Entries marked as checked are left out unless `includeReviewed`. */
export function listSuspicious(
  directory: readonly PayeeEntity[],
  rows: (entityId: number) => { count: number; spellings: Array<{ spelling: string; count: number }> },
  opts: { includeReviewed?: boolean; vocab?: PayeeVocabulary } = {},
): SuspiciousEntry[] {
  const out: SuspiciousEntry[] = [];
  for (const e of directory) {
    if (e.reviewedAt && !opts.includeReviewed) continue;
    const reasons = suspiciousReasons(e.name, { brandSigns: hasBrandSigns(e), vocab: opts.vocab });
    if (!reasons.length) continue;
    const r = rows(e.id);
    out.push({ id: e.id, name: e.name, reasons, count: r.count, spellings: r.spellings });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
