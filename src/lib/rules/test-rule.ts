/**
 * P8 stage 10 — dry-run a v2 condition group against the user's
 * transactions: how many rows match, how many of those have no category yet,
 * and a sample. Shared by the web rule editor («Перевірити на моїх
 * операціях», POST /api/rules/test) and MCP `test_rule` (its `conditions`
 * form). Read only; payees are decrypted in memory.
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { matchesRule, type TransactionInput } from "@/lib/auto-categorize";
import type { PayeeExecutor } from "@/lib/payees/scan";
import { makeMerchantResolver, rulesUseMerchant } from "./merchant-context";
import type { ConditionGroup } from "./schema";

export type RuleTestResult = {
  scanned: number;
  matchedCount: number;
  uncategorizedCount: number;
  matches: Array<{ id: number; date: string; payee: string; amount: number; categoryId: number | null }>;
  /** Stopped at `limit` rows (newest first). */
  truncated: boolean;
};

export const RULE_TEST_MAX = 50_000;

export async function testRuleConditions(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  conditions: ConditionGroup;
  limit?: number;
  sample?: number;
}): Promise<RuleTestResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5_000, RULE_TEST_MAX));
  const sample = opts.sample ?? 50;
  const rule = { id: 0, name: "test", conditions: opts.conditions, actions: [], isActive: true, priority: 0 };
  const rows = normalizeDbRows<Record<string, unknown>>(
    await opts.executor.execute(sql`
      SELECT id, date, payee, note, tags, amount, account_id, currency, category_id
      FROM transactions WHERE user_id = ${opts.userId}
      ORDER BY date DESC, id DESC LIMIT ${limit}`),
  );
  const resolveMerchant = rulesUseMerchant([rule]) ? await makeMerchantResolver(opts.executor, opts.userId, opts.dek) : null;
  const plain = (v: unknown) => (v == null ? "" : opts.dek ? (tryDecryptField(opts.dek, String(v)) ?? "") : String(v));
  const out: RuleTestResult = { scanned: rows.length, matchedCount: 0, uncategorizedCount: 0, matches: [], truncated: rows.length >= limit };
  for (const r of rows) {
    const payee = plain(r.payee);
    const probe: TransactionInput = {
      payee,
      note: plain(r.note),
      tags: plain(r.tags),
      amount: Number(r.amount ?? 0),
      accountId: r.account_id == null ? null : Number(r.account_id),
      enteredCurrency: r.currency == null ? null : String(r.currency),
      date: String(r.date ?? "").slice(0, 10),
    };
    if (resolveMerchant) {
      const m = resolveMerchant(payee);
      probe.merchantEntityId = m.entityId;
      probe.merchantTypeId = m.typeId;
    }
    if (!matchesRule(probe, rule)) continue;
    out.matchedCount++;
    const categoryId = r.category_id == null || Number(r.category_id) === 0 ? null : Number(r.category_id);
    if (categoryId == null) out.uncategorizedCount++;
    if (out.matches.length < sample) out.matches.push({ id: Number(r.id), date: probe.date!, payee, amount: probe.amount!, categoryId });
  }
  return out;
}
