/**
 * POST /api/categories/merge — Settings → Categorization "Merge into…".
 *
 * Body: { sourceId, targetId, dryRun? }. Both ids must belong to the caller.
 *   - dryRun: per-type dependent counts of the source, nothing written.
 *   - otherwise: every dependent of the source is repointed to the target in
 *     one transaction and the source is deleted.
 *
 * The SQL is the shared core in src/lib/categories/merge.ts — the same code
 * MCP `manage_categories` op:"merge" runs.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { apiHandler } from "@/lib/api-handler";
import { isPgErrorCode, normalizeDbRows } from "@/lib/db-utils";
import {
  countBudgetMonthConflicts,
  countCategoryDependents,
  mergeCategoryInto,
  totalCategoryDependents,
} from "@/lib/categories/merge";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";

const bodySchema = z.object({
  sourceId: z.number().int().positive(),
  targetId: z.number().int().positive(),
  dryRun: z.boolean().optional(),
});

/** A unique-index clash during the repoint (e.g. two budgets for one month) → 409. */
function mergeConflict(error: unknown): NextResponse | null {
  if (!isPgErrorCode(error, "23505")) return null;
  return NextResponse.json(
    { error: "The merge would create a duplicate (for example two budgets for the same month). Nothing was changed.", code: "conflict" },
    { status: 409 },
  );
}

export const POST = apiHandler(
  { auth: "encryption", raw: true, body: bodySchema, mapError: mergeConflict, fallbackMessage: "Failed to merge categories" },
  async ({ userId, body }) => {
    const { sourceId, targetId, dryRun } = body;
    if (sourceId === targetId) {
      return NextResponse.json({ error: "Source and target are the same category — nothing to merge." }, { status: 400 });
    }

    const owned = normalizeDbRows<{ id: number | string; type: string }>(
      await db.execute(sql`
        SELECT id, type FROM categories WHERE user_id = ${userId} AND id IN (${sourceId}, ${targetId})
      `),
    );
    const src = owned.find((c) => Number(c.id) === sourceId);
    const tgt = owned.find((c) => Number(c.id) === targetId);
    if (!src || !tgt) return NextResponse.json({ error: "Category not found" }, { status: 404 });

    const dependents = await countCategoryDependents(db, userId, sourceId);
    const budgetConflicts = await countBudgetMonthConflicts(db, userId, sourceId, targetId);
    const summary = {
      sourceId,
      targetId,
      dependents,
      totalDependents: totalCategoryDependents(dependents),
      budgetConflicts,
      typeMismatch: src.type !== tgt.type,
    };
    if (dryRun) return NextResponse.json({ dryRun: true, ...summary });

    if (budgetConflicts > 0) {
      return NextResponse.json(
        {
          error: `Both categories have a budget in ${budgetConflicts} of the same month${budgetConflicts === 1 ? "" : "s"}. Remove one of each pair in Budgets, then merge.`,
          code: "budget_conflict",
          ...summary,
        },
        { status: 409 },
      );
    }

    const repointed = await mergeCategoryInto(db, userId, sourceId, targetId);
    invalidateUserTxCache(userId);
    return NextResponse.json({ merged: true, sourceId, targetId, repointed });
  },
);
