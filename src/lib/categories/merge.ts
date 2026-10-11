/**
 * Merge one category into another — the shared core behind MCP
 * `manage_categories` op:"merge" (FINLYNQ-275) and the Settings →
 * Categorization "Merge into…" action (POST /api/categories/merge).
 *
 * Lifted out of mcp-server/tools/categories.ts with the SQL unchanged, so the
 * MCP tool keeps its exact behaviour (preview counts, response shape, the
 * atomic repoint + source delete). Callers resolve and owner-check both ids
 * first; everything here is additionally `user_id`-scoped.
 *
 * Every table with a `category_id` FK to `categories` (src/db/schema-pg.ts) is
 * repointed: transactions, transaction_splits (owned via transaction_id →
 * transactions; NO user_id column), subscriptions, budgets, budget_templates,
 * recurring_transactions, email_import_rules, plus the FINLYNQ-84
 * transaction_rules JSONB `set_category` action. backfill_proposals
 * (chosen_category_id, ON DELETE SET NULL) is ephemeral review state and
 * deliberately NOT repointed. staged_transactions carries a plain-text
 * `category`, not an FK, so it is out of scope too.
 *
 * KEEP THE COUNT AND THE REPOINT LISTS IN LOCKSTEP WITH THE SCHEMA.
 */

import { sql } from "drizzle-orm";
import { normalizeDbRows } from "../db-utils";
import type { Executor } from "../delete-blockers";

export type CategoryDependentCounts = {
  transactions: number;
  splits: number;
  subscriptions: number;
  budgets: number;
  budgetTemplates: number;
  recurringTransactions: number;
  emailRules: number;
  rules: number;
};

export function totalCategoryDependents(d: CategoryDependentCounts): number {
  return d.transactions + d.splits + d.subscriptions + d.budgets + d.budgetTemplates + d.recurringTransactions + d.emailRules + d.rules;
}

/** Count every dependent of a category, per type. */
export async function countCategoryDependents(
  db: Executor,
  userId: string,
  catId: number,
): Promise<CategoryDependentCounts> {
  const one = async (query: ReturnType<typeof sql>) =>
    Number(normalizeDbRows<{ cnt: string | number }>(await db.execute(query))[0]?.cnt ?? 0);
  const [transactions, splits, subscriptions, budgets, budgetTemplates, recurringTransactions, emailRules, rules] =
    await Promise.all([
      one(sql`SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ${userId} AND category_id = ${catId}`),
      one(sql`
        SELECT COUNT(*) AS cnt FROM transaction_splits ts
        JOIN transactions t ON t.id = ts.transaction_id
        WHERE t.user_id = ${userId} AND ts.category_id = ${catId}
      `),
      one(sql`SELECT COUNT(*) AS cnt FROM subscriptions WHERE user_id = ${userId} AND category_id = ${catId}`),
      one(sql`SELECT COUNT(*) AS cnt FROM budgets WHERE user_id = ${userId} AND category_id = ${catId}`),
      one(sql`SELECT COUNT(*) AS cnt FROM budget_templates WHERE user_id = ${userId} AND category_id = ${catId}`),
      one(sql`SELECT COUNT(*) AS cnt FROM recurring_transactions WHERE user_id = ${userId} AND category_id = ${catId}`),
      one(sql`SELECT COUNT(*) AS cnt FROM email_import_rules WHERE user_id = ${userId} AND category_id = ${catId}`),
      one(sql`
        SELECT COUNT(*) AS cnt FROM transaction_rules
        WHERE user_id = ${userId}
          AND actions @> ${JSON.stringify([{ kind: "set_category", categoryId: catId }])}::jsonb
      `),
    ]);
  return { transactions, splits, subscriptions, budgets, budgetTemplates, recurringTransactions, emailRules, rules };
}

/** The statements of one merge, in execution order. Exported for tests. */
export function buildCategoryMergeStatements(userId: string, srcId: number, tgtId: number): Array<ReturnType<typeof sql>> {
  return [
    // audit-trio: the transactions repoint bumps updated_at (every UPDATE
    // site appends it). The other tables have no audit-trio contract.
    sql`UPDATE transactions SET category_id = ${tgtId}, updated_at = NOW() WHERE user_id = ${userId} AND category_id = ${srcId}`,
    sql`
      UPDATE transaction_splits SET category_id = ${tgtId}
      WHERE category_id = ${srcId}
        AND transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})
    `,
    sql`UPDATE subscriptions SET category_id = ${tgtId} WHERE user_id = ${userId} AND category_id = ${srcId}`,
    sql`UPDATE budgets SET category_id = ${tgtId} WHERE user_id = ${userId} AND category_id = ${srcId}`,
    sql`UPDATE budget_templates SET category_id = ${tgtId} WHERE user_id = ${userId} AND category_id = ${srcId}`,
    sql`UPDATE recurring_transactions SET category_id = ${tgtId} WHERE user_id = ${userId} AND category_id = ${srcId}`,
    sql`UPDATE email_import_rules SET category_id = ${tgtId} WHERE user_id = ${userId} AND category_id = ${srcId}`,
    // FINLYNQ-84 JSONB — rewrite every `set_category` action pointing at
    // src. Element-wise via jsonb_agg + jsonb_set (NOT a text REPLACE —
    // jsonb::text reformats keys/whitespace, so a stringified needle
    // wouldn't match); each matching element's `categoryId` is set to tgt,
    // every other action passed through untouched.
    sql`
      UPDATE transaction_rules
      SET actions = (
        SELECT jsonb_agg(
          CASE
            WHEN elem->>'kind' = 'set_category' AND (elem->>'categoryId')::int = ${srcId}
            THEN jsonb_set(elem, '{categoryId}', to_jsonb(${tgtId}::int))
            ELSE elem
          END
        )
        FROM jsonb_array_elements(actions) AS elem
      )
      WHERE user_id = ${userId}
        AND actions @> ${JSON.stringify([{ kind: "set_category", categoryId: srcId }])}::jsonb
    `,
    // Source now has no dependents → delete it.
    sql`DELETE FROM categories WHERE id = ${srcId} AND user_id = ${userId}`,
  ];
}

type TxCapable = {
  transaction: (fn: (tx: Executor) => Promise<unknown>) => Promise<unknown>;
};

/**
 * Atomically repoint every dependent of `srcId` to `tgtId` and delete the
 * source. Returns the dependent counts taken just before the write (what was
 * moved). `db` must be the real Drizzle instance (it needs `.transaction`).
 *
 * Note: `budgets` is unique on (user_id, category_id, month), so a merge where
 * both categories hold a budget for the same month raises 23505 and the whole
 * transaction rolls back — nothing is half-merged.
 */
export async function mergeCategoryInto(
  db: Executor,
  userId: string,
  srcId: number,
  tgtId: number,
): Promise<CategoryDependentCounts> {
  // Re-count right before the atomic write so the response reflects what was
  // actually moved (a row could have changed between preview and commit).
  const before = await countCategoryDependents(db, userId, srcId);
  const statements = buildCategoryMergeStatements(userId, srcId, tgtId);
  await (db as unknown as TxCapable).transaction(async (tx) => {
    for (const stmt of statements) await tx.execute(stmt);
  });
  return before;
}

/**
 * Months in which BOTH categories hold a budget. `budgets` is unique on
 * (user_id, category_id, month), so any such month would make the merge's
 * budgets repoint raise 23505. The Settings route refuses up front with this
 * count instead of letting the transaction roll back on a raw constraint
 * error. (MCP keeps its original behaviour and is not gated on it.)
 */
export async function countBudgetMonthConflicts(
  db: Executor,
  userId: string,
  srcId: number,
  tgtId: number,
): Promise<number> {
  const rows = normalizeDbRows<{ cnt: string | number }>(
    await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM budgets s
      JOIN budgets t ON t.user_id = s.user_id AND t.month = s.month AND t.category_id = ${tgtId}
      WHERE s.user_id = ${userId} AND s.category_id = ${srcId}
    `),
  );
  return Number(rows[0]?.cnt ?? 0);
}
