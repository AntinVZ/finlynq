/**
 * src/lib/categories/merge.ts — the shared merge core behind MCP
 * manage_categories op:"merge" and POST /api/categories/merge. DB-free: the
 * executor records the rendered SQL, so these pin the table coverage, the
 * user scoping and the single-transaction shape. The DB-backed behaviour is
 * covered by tests/mcp/manage-categories-rename-merge.test.ts (needs a
 * *_test Postgres).
 */
import { describe, it, expect } from "vitest";
import { renderSql } from "./helpers/tag-ledger";
import {
  buildCategoryMergeStatements,
  countBudgetMonthConflicts,
  countCategoryDependents,
  mergeCategoryInto,
  totalCategoryDependents,
} from "@/lib/categories/merge";
import type { SQL } from "drizzle-orm";

function recorder(countFor: (sql: string) => number = () => 0) {
  const log: Array<{ sql: string; params: unknown[]; inTx: boolean }> = [];
  let inTx = false;
  const exec = async (q: SQL) => {
    const r = renderSql(q);
    log.push({ ...r, inTx });
    return { rows: [{ cnt: String(countFor(r.sql)) }], rowCount: 1 };
  };
  const db = {
    execute: exec,
    transaction: async (fn: (tx: { execute: typeof exec }) => Promise<unknown>) => {
      inTx = true;
      try {
        return await fn({ execute: exec });
      } finally {
        inTx = false;
      }
    },
  };
  return { db, log };
}

describe("category merge core", () => {
  it("repoints every category_id FK table + rule JSONB, then deletes the source", () => {
    const stmts = buildCategoryMergeStatements("u1", 5, 9).map((s) => renderSql(s).sql);
    const tables = stmts.map((s) => /^\s*(UPDATE|DELETE FROM) (\w+)/.exec(s)?.[2]);
    expect(tables).toEqual([
      "transactions",
      "transaction_splits",
      "subscriptions",
      "budgets",
      "budget_templates",
      "recurring_transactions",
      "email_import_rules",
      "transaction_rules",
      "categories",
    ]);
    // Every statement is owner-scoped (splits via the transactions sub-select).
    for (const s of stmts) expect(s).toMatch(/user_id = \$/);
    expect(stmts[0]).toMatch(/updated_at = NOW\(\)/);
  });

  it("counts every dependent type and totals them", async () => {
    const { db } = recorder((s) => (/FROM transactions WHERE/.test(s) ? 3 : /FROM budgets/.test(s) ? 1 : 0));
    const counts = await countCategoryDependents(db, "u1", 5);
    expect(counts).toEqual({
      transactions: 3,
      splits: 0,
      subscriptions: 0,
      budgets: 1,
      budgetTemplates: 0,
      recurringTransactions: 0,
      emailRules: 0,
      rules: 0,
    });
    expect(totalCategoryDependents(counts)).toBe(4);
  });

  it("mergeCategoryInto counts first, then runs all writes inside one transaction", async () => {
    const { db, log } = recorder((s) => (/FROM transactions WHERE/.test(s) ? 2 : 0));
    const before = await mergeCategoryInto(db, "u1", 5, 9);
    expect(before.transactions).toBe(2);
    const writes = log.filter((l) => /^\s*(UPDATE|DELETE)/.test(l.sql));
    expect(writes).toHaveLength(9);
    expect(writes.every((w) => w.inTx)).toBe(true);
    expect(log.filter((l) => /SELECT COUNT/.test(l.sql)).every((l) => !l.inTx)).toBe(true);
    // Source and target ids land in the params, never inlined.
    expect(writes[0].params).toEqual([9, "u1", 5]);
  });

  it("countBudgetMonthConflicts joins source and target budgets on month", async () => {
    const { db, log } = recorder(() => 2);
    expect(await countBudgetMonthConflicts(db, "u1", 5, 9)).toBe(2);
    expect(log[0].sql).toMatch(/t\.month = s\.month/);
    expect(log[0].params).toEqual([9, "u1", 5]);
  });
});
