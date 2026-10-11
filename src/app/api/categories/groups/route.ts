/**
 * POST /api/categories/groups — rename a category group.
 *
 * Categories stay two-level (group → category); a group is just the plaintext
 * `categories.group` label, so renaming one rewrites that label on every
 * category of the caller that carries it. Renaming onto an existing group
 * folds the two groups together.
 *
 * Body: { from, to, dryRun? }. dryRun returns how many categories would move
 * and whether `to` already exists; nothing is written.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { requireAuth } from "@/lib/auth/require-auth";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";

const bodySchema = z.object({
  from: z.string(),
  to: z.string().trim().min(1, "New group name is required").max(100),
  dryRun: z.boolean().optional(),
});

async function countInGroup(userId: string, group: string): Promise<number> {
  const rows = normalizeDbRows<{ n: string | number }>(
    await db.execute(sql`SELECT COUNT(*) AS n FROM categories WHERE user_id = ${userId} AND "group" = ${group}`),
  );
  return Number(rows[0]?.n ?? 0);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const parsed = validateBody(await request.json(), bodySchema);
    if (parsed.error) return parsed.error;
    const { from, to, dryRun } = parsed.data;

    const affected = await countInGroup(userId, from);
    const targetCount = from === to ? 0 : await countInGroup(userId, to);
    const preview = { from, to, affected, targetExists: targetCount > 0, targetCount };
    if (dryRun || affected === 0 || from === to) return NextResponse.json({ dryRun: !!dryRun, ...preview, updated: 0 });

    const rows = normalizeDbRows<{ id: number }>(
      await db.execute(sql`
        UPDATE categories SET "group" = ${to} WHERE user_id = ${userId} AND "group" = ${from} RETURNING id
      `),
    );
    invalidateUserTxCache(userId);
    return NextResponse.json({ ...preview, updated: rows.length });
  } catch (error: unknown) {
    await logApiError("POST", "/api/categories/groups", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to rename group") }, { status: 500 });
  }
}
