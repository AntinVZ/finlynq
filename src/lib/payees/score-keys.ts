/**
 * Pair scoring for payee matching keys (Payee Studio). Pure and free of
 * Node-only imports, so the web picker can rank directory entries by how
 * alike they are to the payees being merged with the same rules clustering
 * uses (./overview.ts re-exports it).
 */
import { keySimilarity } from "./match-key";
import { brandCoreOfKey, type PayeeVocabulary } from "./type-words";
import { st } from "@/lib/i18n/current";

/** A pair score. `sameBrand` = the brand cores agree (equal, or one continues the other); false = only spelled alike. */
export type KeyScore = { confidence: number; reason: string; sameBrand: boolean };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * How alike two DIFFERENT matching keys are, compared on their brand cores
 * (one-letter tokens and type words removed): same core 0.9, one continues
 * the other 0.75, small edit distance 0.6–0.88 (then `sameBrand` is false:
 * different brand tokens are only ever joined by a person). Null below that,
 * and null when either key is nothing but type words. Identical keys are the
 * caller's business.
 */
export function scoreKeys(keyA: string, keyB: string, vocab?: PayeeVocabulary): KeyScore | null {
  if (!keyA || !keyB) return null;
  const A = brandCoreOfKey(keyA, vocab);
  const B = brandCoreOfKey(keyB, vocab);
  if (A.typeOnly || B.typeOnly) return null;
  const ca = A.core;
  const cb = B.core;
  if (ca === cb) {
    const reason = A.removed.length || B.removed.length ? st("srv.score.sameApartFromTypeWord") : st("srv.score.sameApartFromLegalForm");
    return { confidence: 0.9, reason, sameBrand: true };
  }
  const ta = ca.split(" ");
  const tb = cb.split(" ");
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.join(" ").length >= 5 && short.every((t, i) => long[i] === t)) {
    return { confidence: 0.75, reason: st("srv.score.continues"), sameBrand: true };
  }
  if (Math.min(ca.length, cb.length) >= 5) {
    const sim = keySimilarity(ca, cb);
    if (sim >= 0.85) {
      const letters = Math.round((1 - sim) * Math.max(ca.length, cb.length));
      return {
        confidence: Math.min(0.88, round2(0.6 + (sim - 0.85) * 2)),
        reason: st("srv.score.lettersDiffer", { n: letters }),
        sameBrand: false,
      };
    }
  }
  return null;
}
