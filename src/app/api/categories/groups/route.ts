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
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { apiHandler } from "@/lib/api-handler";
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

export const POST = apiHandler(
  { auth: "auth", raw: true, body: bodySchema, fallbackMessage: "Failed to rename group" },
  async ({ userId, body }) => {
    const { from, to, dryRun } = body;

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
  },
);
