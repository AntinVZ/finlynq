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
 * P8 stage 11 adds two checks that are not about the name:
 *   - large_untyped: no merchant type and a sum above Q3 + 1.5·IQR of the
 *     directory's entry sums (the existing quartiles, at least 4 entries);
 *   - own_requisite: one of its requisites is one of your own accounts or
 *     cards (B26 / B27) — usually a transfer between your accounts.
 *
 * Pure: works on a loaded directory and its row counts.
 */
import { payeeMatchKey, payeeTokens } from "./match-key";
import { brandCoreOfKey, defaultVocabulary, type PayeeVocabulary } from "./type-words";
import type { PayeeEntity } from "./directory";
import { st } from "@/lib/i18n/current";
import { describeOwnAccount, type OwnMatcher } from "./own-accounts";
import { quantile } from "./merchant-analytics";

export type SuspicionCode = "short" | "no_letters" | "latin_no_brand" | "large_untyped" | "own_requisite";

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
  rows: (entityId: number) => { count: number; spellings: Array<{ spelling: string; count: number }>; total?: number },
  opts: { includeReviewed?: boolean; vocab?: PayeeVocabulary; own?: OwnMatcher } = {},
): SuspiciousEntry[] {
  const out: SuspiciousEntry[] = [];
  const sums = directory.map((e) => Math.abs(rows(e.id).total ?? 0)).filter((v) => v > 0).sort((a, b) => a - b);
  const large = sums.length >= 4 ? quantile(sums, 0.75) + 1.5 * (quantile(sums, 0.75) - quantile(sums, 0.25)) : Infinity;
  for (const e of directory) {
    if (e.reviewedAt && !opts.includeReviewed) continue;
    const reasons = suspiciousReasons(e.name, { brandSigns: hasBrandSigns(e), vocab: opts.vocab });
    const r = rows(e.id);
    const total = Math.abs(r.total ?? 0);
    if (e.merchantTypeId == null && total > large) reasons.push({ code: "large_untyped", reason: st("srv.suspicious.largeUntyped") });
    const own = opts.own?.forEntity(e);
    if (own) reasons.push({ code: "own_requisite", reason: st("srv.suspicious.ownRequisite", { account: describeOwnAccount(own) }) });
    if (!reasons.length) continue;
    out.push({ id: e.id, name: e.name, reasons, count: r.count, spellings: r.spellings });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
