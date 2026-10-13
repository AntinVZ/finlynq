/**
 * «Рекомендовано: X» (P8 stage 4): which directory entry a typed or imported
 * payee resolves to — the same matcher the import hint uses (exact /
 * contains / regex aliases), cached per user for a minute. Read only:
 * nothing is renamed here; the person clicks the chip to take the name.
 */
import { buildPayeeMatcher, loadDirectory, type PayeeMatcher } from "./directory";
import { getCachedPayeeMatcher, setCachedPayeeMatcher } from "./suggest";
import type { PayeeExecutor } from "./scan";

export type PayeeRecommendation =
  | { kind: "match"; entityId: number; name: string; via: string; same: boolean }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none" };

async function matcherFor(opts: { executor: PayeeExecutor; userId: string; dek: Buffer }): Promise<PayeeMatcher> {
  let matcher = getCachedPayeeMatcher(opts.userId);
  if (!matcher) {
    matcher = buildPayeeMatcher(await loadDirectory(opts.executor, opts.userId, opts.dek));
    setCachedPayeeMatcher(opts.userId, matcher);
  }
  return matcher;
}

function recommendWith(matcher: PayeeMatcher, raw: string): PayeeRecommendation {
  const payee = raw.replace(/\s+/g, " ").trim();
  if (!payee) return { kind: "none" };
  const m = matcher.match(payee);
  if (m.kind === "match") return { kind: "match", entityId: m.entityId, name: m.name, via: m.via, same: m.name === payee };
  if (m.kind === "ambiguous") return { kind: "ambiguous", names: m.names };
  return { kind: "none" };
}

export async function recommendPayee(opts: { executor: PayeeExecutor; userId: string; dek: Buffer | null; payee: string }): Promise<PayeeRecommendation> {
  if (!opts.payee.trim() || !opts.dek) return { kind: "none" };
  return recommendWith(await matcherFor({ ...opts, dek: opts.dek }), opts.payee);
}

/** Many payees at once (an import's rows): payee → recommendation, only the ones that resolve. */
export async function recommendPayees(opts: { executor: PayeeExecutor; userId: string; dek: Buffer | null; payees: readonly string[] }): Promise<Record<string, PayeeRecommendation>> {
  const out: Record<string, PayeeRecommendation> = {};
  if (!opts.dek) return out;
  const matcher = await matcherFor({ ...opts, dek: opts.dek });
  for (const p of new Set(opts.payees)) {
    const r = recommendWith(matcher, p);
    if (r.kind !== "none") out[p] = r;
  }
  return out;
}
