/**
 * "Why (not) clustered?" (Payee Studio P5a) — explains in plain words how the
 * clustering in ./overview.ts sees two payees: their matching keys, the core
 * (key without one-letter tokens), the 4-letter block the clustering compares
 * within, the type guess, the `scoreKeys` result, and the exact rule that
 * joined or kept them apart. Pure; GET /api/payees/explain and MCP
 * `manage_payees op=explain` call it.
 */
import { coreOfKey, guessPayeeType, payeeMatchKey, payeeTokens, type TypeGuess } from "./match-key";
import { blockKeyOf, MIN_EDGE_CONFIDENCE, scoreKeys } from "./overview";
import type { PayeeMatcher } from "./directory";

export type ExplainSide = {
  payee: string;
  key: string;
  core: string;
  block: string;
  tokens: string[];
  legalWords: string[];
  type: TypeGuess;
  entity: { id: number; name: string } | null;
  ambiguous: string[] | null;
};

export type PayeeExplanation = {
  a: ExplainSide;
  b: ExplainSide;
  sameKey: boolean;
  score: { confidence: number; reason: string } | null;
  /** clustered = would be put together; separate = kept apart; settled = both already resolve to one entity. */
  verdict: "same_name" | "clustered" | "separate" | "settled";
  /** Why, one line per rule that decided it. */
  reasons: string[];
};

function side(payee: string, matcher?: PayeeMatcher): ExplainSide {
  const t = payeeTokens(payee);
  const key = payeeMatchKey(payee);
  const m = matcher ? matcher.match(payee.replace(/\s+/g, " ").trim()) : null;
  return {
    payee,
    key,
    core: coreOfKey(key),
    block: blockKeyOf(key),
    tokens: t.kept,
    legalWords: t.legal,
    type: guessPayeeType(payee),
    entity: m?.kind === "match" ? { id: m.entityId, name: m.name } : null,
    ambiguous: m?.kind === "ambiguous" ? m.names : null,
  };
}

export function explainPayeePair(a: string, b: string, matcher?: PayeeMatcher): PayeeExplanation {
  const A = side(a, matcher);
  const B = side(b, matcher);
  const reasons: string[] = [];
  const score = scoreKeys(A.key, B.key);
  if (!A.key || !B.key) {
    reasons.push(`${!A.key ? "The first" : "The second"} payee has no letters or digits left after removing card-terminal noise.`);
    return { a: A, b: B, sameKey: false, score: null, verdict: "separate", reasons };
  }
  if (A.entity && B.entity && A.entity.id === B.entity.id) {
    reasons.push(`Both already resolve to the directory entry “${A.entity.name}” (#${A.entity.id}); nothing to cluster.`);
    return { a: A, b: B, sameKey: A.key === B.key, score, verdict: "settled", reasons };
  }
  if (A.key === B.key) {
    reasons.push(`Same matching key “${A.key}”: they are one name (letter case, apostrophes, Latin/Cyrillic spelling and terminal noise are ignored) and show as one row.`);
    return { a: A, b: B, sameKey: true, score: null, verdict: "same_name", reasons };
  }
  let separate = false;
  if (A.type.isPerson !== B.type.isPerson) {
    const p = A.type.isPerson ? A : B;
    reasons.push(`“${p.payee}” looks like a private person or sole proprietor (${p.type.reason}) and the other doesn't; people are never paired with merchants.`);
    separate = true;
  }
  if (A.block !== B.block) {
    reasons.push(`Different first letters of the core (“${A.block}” vs “${B.block}”): clustering only compares names that start alike, so this pair is never scored.`);
    separate = true;
  }
  if (!score) {
    reasons.push(
      `The cores “${A.core}” and “${B.core}” are not close enough: not the same apart from a one-letter suffix, neither continues the other (the shorter needs 5+ characters), and they differ by more than 15% of their letters.`,
    );
    separate = true;
  } else if (score.confidence < MIN_EDGE_CONFIDENCE) {
    reasons.push(`Score ${Math.round(score.confidence * 100)}% (${score.reason}) is below the ${Math.round(MIN_EDGE_CONFIDENCE * 100)}% clustering threshold.`);
    separate = true;
  } else {
    reasons.push(`Score ${Math.round(score.confidence * 100)}%: ${score.reason}.`);
  }
  if (A.entity && B.entity && A.entity.id !== B.entity.id) {
    reasons.push(`They resolve to two different directory entries (“${A.entity.name}” and “${B.entity.name}”); merge those entries to join them.`);
  }
  return { a: A, b: B, sameKey: false, score, verdict: separate ? "separate" : "clustered", reasons };
}
