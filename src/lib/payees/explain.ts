/**
 * "Why (not) clustered?" (Payee Studio P5a) — explains in plain words how the
 * clustering in ./overview.ts sees two payees: their matching keys, the core
 * (key without one-letter tokens), the 4-letter block the clustering compares
 * within, the type guess, the `scoreKeys` result, and the exact rule that
 * joined or kept them apart. Pure; GET /api/payees/explain and MCP
 * `manage_payees op=explain` call it.
 *
 * P6: each side also shows its brand — the type words stripped from the core
 * and the brand tokens left (`стоп-слово прибрано: ресторан; ядро: dacha;
 * бренд-токен: dacha`), a bank service row, and person-name pairing (B24).
 */
import { coreOfKey, guessPayeeType, payeeMatchKey, payeeTokens, type TypeGuess } from "./match-key";
import { bankOperationOf, brandCoreOfKey, personNameKey, type PayeeVocabulary } from "./type-words";
import { blockKeyOf, MIN_EDGE_CONFIDENCE, scoreKeys } from "./overview";
import type { PayeeMatcher } from "./directory";
import { st } from "@/lib/i18n/current";

export type ExplainSide = {
  payee: string;
  key: string;
  core: string;
  block: string;
  /** P6: type words removed from the core, the brand tokens left, and the line that says so. */
  typeWordsRemoved: string[];
  brandTokens: string[];
  typeOnly: boolean;
  brandLine: string;
  /** P6 (B25): the bank-operation pattern this payee matches. */
  bankOperation: string | null;
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

/** «стоп-слово прибрано: ресторан; ядро: dacha; бренд-токен: dacha» */
function brandLineOf(core: string, removed: string[], brand: string[], typeOnly: boolean): string {
  const parts = [removed.length ? st("srv.explain.stopWordsRemoved", { words: removed.join(", ") }) : st("srv.explain.noStopWords"), st("srv.explain.core", { core: core || "—" })];
  parts.push(typeOnly ? st("srv.explain.noBrandToken") : st("srv.explain.brandToken", { brand: brand.join(" ") || "—" }));
  return parts.join("; ");
}

function side(payee: string, matcher?: PayeeMatcher, vocab?: PayeeVocabulary): ExplainSide {
  const t = payeeTokens(payee);
  const key = payeeMatchKey(payee);
  const m = matcher ? matcher.match(payee.replace(/\s+/g, " ").trim()) : null;
  const bc = brandCoreOfKey(key, vocab);
  return {
    payee,
    key,
    core: coreOfKey(key, vocab),
    block: blockKeyOf(key, vocab),
    typeWordsRemoved: bc.removed,
    brandTokens: bc.brandTokens,
    typeOnly: bc.typeOnly,
    brandLine: brandLineOf(bc.core, bc.removed, bc.brandTokens, bc.typeOnly),
    bankOperation: bankOperationOf(payee, vocab),
    tokens: t.kept,
    legalWords: t.legal,
    type: guessPayeeType(payee),
    entity: m?.kind === "match" ? { id: m.entityId, name: m.name } : null,
    ambiguous: m?.kind === "ambiguous" ? m.names : null,
  };
}

export function explainPayeePair(a: string, b: string, matcher?: PayeeMatcher, vocab?: PayeeVocabulary): PayeeExplanation {
  const A = side(a, matcher, vocab);
  const B = side(b, matcher, vocab);
  const reasons: string[] = [];
  const score = scoreKeys(A.key, B.key, vocab);
  if (!A.key || !B.key) {
    reasons.push(!A.key ? st("srv.explain.firstNoKey") : st("srv.explain.secondNoKey"));
    return { a: A, b: B, sameKey: false, score: null, verdict: "separate", reasons };
  }
  if (A.entity && B.entity && A.entity.id === B.entity.id) {
    reasons.push(st("srv.explain.settled", { name: A.entity.name, id: A.entity.id }));
    return { a: A, b: B, sameKey: A.key === B.key, score, verdict: "settled", reasons };
  }
  if (A.key === B.key) {
    reasons.push(st("srv.explain.sameKey", { key: A.key }));
    return { a: A, b: B, sameKey: true, score: null, verdict: "same_name", reasons };
  }
  let separate = false;
  for (const x of [A, B]) {
    if (x.bankOperation) {
      reasons.push(st("srv.explain.bankOperation", { payee: x.payee, pattern: x.bankOperation }));
      separate = true;
    } else if (x.typeOnly) {
      reasons.push(st("srv.explain.typeOnly", { payee: x.payee, words: x.typeWordsRemoved.join(", ") }));
      separate = true;
    }
  }
  if (separate) return { a: A, b: B, sameKey: false, score: null, verdict: "separate", reasons };
  const pa = personNameKey(A.tokens);
  if (pa && pa === personNameKey(B.tokens) && (A.type.isPerson || B.type.isPerson)) {
    reasons.push(st("srv.explain.samePerson", { name: pa }));
    return { a: A, b: B, sameKey: false, score, verdict: "clustered", reasons };
  }
  if (A.type.isPerson !== B.type.isPerson) {
    const p = A.type.isPerson ? A : B;
    reasons.push(st("srv.explain.personVsMerchant", { payee: p.payee, reason: p.type.reason }));
    separate = true;
  }
  if (A.block !== B.block) {
    reasons.push(st("srv.explain.differentBlock", { a: A.block, b: B.block }));
    separate = true;
  }
  if (!score) {
    reasons.push(
      st("srv.explain.notClose", { a: A.core, b: B.core }),
    );
    separate = true;
  } else if (score.confidence < MIN_EDGE_CONFIDENCE) {
    reasons.push(st("srv.explain.belowThreshold", { score: Math.round(score.confidence * 100), reason: score.reason, threshold: Math.round(MIN_EDGE_CONFIDENCE * 100) }));
    separate = true;
  } else {
    reasons.push(st("srv.explain.score", { score: Math.round(score.confidence * 100), reason: score.reason }));
    if (!score.sameBrand) reasons.push(st("srv.explain.brandDiffers", { a: A.brandTokens.join(" "), b: B.brandTokens.join(" ") }));
  }
  if (A.entity && B.entity && A.entity.id !== B.entity.id) {
    reasons.push(st("srv.explain.twoEntities", { a: A.entity.name, b: B.entity.name }));
  }
  return { a: A, b: B, sameKey: false, score, verdict: separate ? "separate" : "clustered", reasons };
}
