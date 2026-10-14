/**
 * P8 stage 10 — merchant-aware rules. A rule condition `merchant is X` or
 * `merchant_type is T` needs to know which directory entry a row's payee
 * resolves to. This module fills `merchantEntityId` / `merchantTypeId` on
 * rule inputs, through the same cached matcher the import hint and the
 * «Рекомендовано» chip use (exact / contains / regex aliases; ambiguous or
 * unknown payees stay unresolved, and an unresolved payee matches neither
 * `is` nor `is_not`). It also keeps the rule hit counter.
 *
 * Nothing here renames a payee or touches `import_hash`; loading the
 * directory is skipped unless a rule actually uses a merchant condition.
 */
import { sql } from "drizzle-orm";
import { matcherFor } from "@/lib/payees/resolve-hint";
import type { PayeeExecutor } from "@/lib/payees/scan";
import type { TransactionInput, TransactionRule } from "@/lib/auto-categorize";
import type { ConditionGroup } from "./schema";

/** Does any rule have a `merchant` / `merchant_type` condition? */
export function rulesUseMerchant(rules: ReadonlyArray<{ conditions: { all?: ReadonlyArray<{ field?: string }> } | ConditionGroup }>): boolean {
  return rules.some((r) => (r.conditions?.all ?? []).some((c) => c.field === "merchant" || c.field === "merchant_type"));
}

export type MerchantResolver = (payee: string | null | undefined) => { entityId: number | null; typeId: number | null };

const NONE = { entityId: null, typeId: null };

/** payee → directory entry + its merchant type (both null when unresolved or without a DEK). Never throws. */
export async function makeMerchantResolver(executor: PayeeExecutor, userId: string, dek: Buffer | null | undefined): Promise<MerchantResolver> {
  if (!dek) return () => NONE;
  try {
    const matcher = await matcherFor({ executor, userId, dek });
    return (payee) => {
      const p = String(payee ?? "").replace(/\s+/g, " ").trim();
      if (!p) return NONE;
      const m = matcher.match(p);
      if (m.kind !== "match") return NONE;
      return { entityId: m.entityId, typeId: matcher.entity(m.entityId)?.merchantTypeId ?? null };
    };
  } catch (err) {
    console.warn("[rules] merchant context unavailable:", err instanceof Error ? err.message : String(err));
    return () => NONE;
  }
}

/** Fill the merchant fields of rule inputs in place — only when a rule needs them. */
export async function withMerchantContext<T extends TransactionInput>(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null | undefined;
  rules: ReadonlyArray<TransactionRule>;
  inputs: T[];
}): Promise<T[]> {
  if (!opts.inputs.length || !rulesUseMerchant(opts.rules)) return opts.inputs;
  const resolve = await makeMerchantResolver(opts.executor, opts.userId, opts.dek);
  for (const t of opts.inputs) {
    const r = resolve(t.payee);
    t.merchantEntityId = r.entityId;
    t.merchantTypeId = r.typeId;
  }
  return opts.inputs;
}

/**
 * Count rule hits: `hits` maps rule id → rows it filled. One UPDATE per call;
 * user-scoped; never throws (a counter must not break an import).
 */
export async function recordRuleHits(executor: PayeeExecutor, userId: string, hits: ReadonlyMap<number, number> | ReadonlyArray<number>): Promise<void> {
  const counts = new Map<number, number>();
  if (Array.isArray(hits)) for (const id of hits as ReadonlyArray<number>) counts.set(id, (counts.get(id) ?? 0) + 1);
  else for (const [id, n] of hits as ReadonlyMap<number, number>) counts.set(id, (counts.get(id) ?? 0) + n);
  const list = [...counts.entries()].filter(([id, n]) => Number.isInteger(id) && id > 0 && n > 0);
  if (!list.length) return;
  try {
    const cases = sql.join(list.map(([id, n]) => sql`WHEN ${id}::int THEN ${n}::int`), sql` `);
    const ids = sql.join(list.map(([id]) => sql`${id}::int`), sql`, `);
    await executor.execute(sql`
      UPDATE transaction_rules SET hit_count = hit_count + (CASE id ${cases} ELSE 0 END), last_hit_at = NOW()
      WHERE user_id = ${userId} AND id IN (${ids})`);
  } catch (err) {
    console.warn("[rules] hit counter skipped:", err instanceof Error ? err.message : String(err));
  }
}
