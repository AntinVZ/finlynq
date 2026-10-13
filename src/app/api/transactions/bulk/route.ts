/**
 * POST /api/transactions/bulk — bulk operations on transactions
 *
 * Body: { action, ids, ...params }
 *
 * Actions:
 *   delete              — delete all transactions in ids[]
 *   update_category     — set categoryId for all ids[]
 *   update_account      — set accountId for all ids[]
 *   update_date         — set date for all ids[]
 *   update_note         — set note for all ids[]
 *   update_payee        — set payee for all ids[]
 *   update_tags         — set tags for all ids[] (replaces the whole list)
 *   add_tag             — add `tag` (one tag or a comma list) to every row,
 *                         keeping each row's existing tags and their order
 *   remove_tag          — remove `tag` (one tag or a comma list) from every row
 *
 * `add_tag` / `remove_tag` compare tags by `normalizeForMatch` (lib/tags.ts):
 * `Agrotrade`, `agrotrade ` and `AGROTRADE` are one tag. Each row is read,
 * decrypted, edited and re-encrypted through `rewriteTransactionTags`, in
 * batches; rows that wouldn't change are not written. `affected` reports the
 * rows actually changed.
 *
 * `delete` runs through the shared `deleteTransactionsCascade` chokepoint
 * (2026-07-30) — it used to be a bare `DELETE WHERE id IN (…)`, which orphaned
 * the other leg of every transfer / trade pair, left lot closures pointing at
 * deleted opens, and never stamped a snapshot-dirty marker.
 *
 * `update_account` and `update_date` REFUSE portfolio-op rows for the same
 * class of reason: re-pointing one leg of a linked pair at a different account
 * (or moving only one leg's date) silently breaks the paired-legs invariant,
 * and the single-row PUT already guards this. Use /portfolio/new?op=&editId=.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { encryptField } from "@/lib/crypto/envelope";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { db, schema } from "@/db";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";
import { deleteTransactionsCascade } from "@/lib/transactions/delete-cascade";
import { rewriteTransactionTags } from "@/lib/transactions/rewrite-tags";
import { addTags, removeTags, toTagList } from "@/lib/tags";

const { transactions } = schema;

// Issue #28: every UPDATE site bumps updated_at = NOW() so the audit
// timestamp reflects the row's last mutation. Hoisted into a constant so
// re-using it in each switch arm reads as one chokepoint.
const AUDIT_BUMP = { updatedAt: sql`NOW()` } as const;

// add_tag / remove_tag rewrite each row individually; same per-call ceiling as
// the MCP bulk tools.
const BULK_TAG_MAX_IDS = 10_000;

const bulkSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("delete"),
    ids: z.array(z.number()).min(1),
  }),
  z.object({
    action: z.literal("update_category"),
    ids: z.array(z.number()).min(1),
    categoryId: z.number(),
  }),
  z.object({
    action: z.literal("update_account"),
    ids: z.array(z.number()).min(1),
    accountId: z.number(),
  }),
  z.object({
    action: z.literal("update_date"),
    ids: z.array(z.number()).min(1),
    date: z.string(),
  }),
  z.object({
    action: z.literal("update_note"),
    ids: z.array(z.number()).min(1),
    note: z.string(),
  }),
  z.object({
    action: z.literal("update_payee"),
    ids: z.array(z.number()).min(1),
    payee: z.string(),
  }),
  z.object({
    action: z.literal("update_tags"),
    ids: z.array(z.number()).min(1),
    tags: z.string(),
  }),
  z.object({
    action: z.literal("add_tag"),
    ids: z.array(z.number()).min(1).max(BULK_TAG_MAX_IDS),
    tag: z.string().max(500).refine((v) => toTagList(v).length > 0, { message: "tag is required" }),
  }),
  z.object({
    action: z.literal("remove_tag"),
    ids: z.array(z.number()).min(1).max(BULK_TAG_MAX_IDS),
    tag: z.string().max(500).refine((v) => toTagList(v).length > 0, { message: "tag is required" }),
  }),
]);

export async function POST(request: NextRequest) {
  // Parse the body once so we can pick the right auth guard. Text-field
  // actions need the DEK; ID/number-only actions don't.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = validateBody(body, bulkSchema);
  if (parsed.error) return parsed.error;

  const needsDek =
    parsed.data.action === "update_note" ||
    parsed.data.action === "update_payee" ||
    parsed.data.action === "update_tags" ||
    parsed.data.action === "add_tag" ||
    parsed.data.action === "remove_tag";

  let userId: string;
  let dek: Buffer | null = null;
  if (needsDek) {
    const encAuth = await requireEncryption(request);
    if (!encAuth.ok) return encAuth.response;
    userId = encAuth.userId;
    dek = encAuth.dek;
  } else {
    const baseAuth = await requireAuth(request);
    if (!baseAuth.authenticated) return baseAuth.response;
    userId = baseAuth.context.userId;
  }

  try {
    const { action, ids } = parsed.data;

    // Cross-tenant FK guard (H-1) — `update_category` and `update_account`
    // re-point the FK on every selected row. Without verification, the new
    // FK could belong to another user, attaching their account/category to
    // the caller's transactions on every aggregator/report.
    if (action === "update_category") {
      await verifyOwnership(userId, { categoryIds: [parsed.data.categoryId] });
    } else if (action === "update_account") {
      await verifyOwnership(userId, { accountIds: [parsed.data.accountId] });
    }

    // Re-pointing a linked / portfolio-op row's ACCOUNT or DATE in bulk moves
    // one leg without its sibling: the pair stops summing to zero across the
    // two accounts, and a date move desynchronizes lot ordering. The single-row
    // surfaces route these edits through /portfolio/new?op=&editId=, which
    // rewrites the whole pair. Refuse here rather than silently corrupting.
    if (action === "update_account" || action === "update_date") {
      const linked = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(transactions.id, ids),
            or(
              isNotNull(transactions.portfolioHoldingId),
              isNotNull(transactions.tradeLinkId),
              isNotNull(transactions.linkId),
              isNotNull(transactions.swapLinkId),
            ),
          ),
        );
      if (linked.length > 0) {
        const blockedIds = linked.map((r) => r.id);
        return NextResponse.json(
          {
            error:
              `${blockedIds.length} of the selected transaction(s) belong to a transfer, trade or ` +
              `portfolio operation. Changing only one leg's ${action === "update_account" ? "account" : "date"} ` +
              `would break the paired rows — edit them individually instead.`,
            code: "portfolio_bulk_edit_refused",
            blockedIds,
          },
          { status: 409 },
        );
      }
    }

    // All operations are scoped to the user's own transactions
    switch (action) {
      case "delete": {
        // Shared chokepoint — link-sibling cascade, portfolio edit-guard, lot
        // reversal, one-statement delete, snapshot-dirty markers, tx-cache
        // invalidation. The whole cascade runs in one DB transaction.
        const outcome = await deleteTransactionsCascade(userId, ids);
        if (!outcome.ok) {
          if (outcome.reason === "not_found") {
            return NextResponse.json({ error: "Not found" }, { status: 404 });
          }
          return NextResponse.json(
            {
              error: outcome.message,
              code: "portfolio_edit_blocked",
              blockingClosureTxIds: outcome.blockingClosureTxIds,
            },
            { status: 409 },
          );
        }
        // `affected` counts what was actually removed (cascade included), not
        // what the caller listed.
        return NextResponse.json({
          success: true,
          affected: outcome.deletedIds.length,
          deletedIds: outcome.deletedIds,
          cascaded: outcome.cascaded,
        });
      }

      case "update_category":
        await db
          .update(transactions)
          .set({ categoryId: parsed.data.categoryId, ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_account":
        await db
          .update(transactions)
          .set({ accountId: parsed.data.accountId, ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_date":
        await db
          .update(transactions)
          .set({ date: parsed.data.date, ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_note":
        await db
          .update(transactions)
          .set({ note: encryptField(dek!, parsed.data.note), ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_payee": {
        // P8 stage 10 (B33): the import hint applies to a bulk payee edit too.
        const { canonicalPayeeHint } = await import("@/lib/payees/import-assist");
        const payee = (parsed.data.payee && (await canonicalPayeeHint(db, userId, dek!, parsed.data.payee).catch(() => null))) || parsed.data.payee;
        await db
          .update(transactions)
          .set({ payee: encryptField(dek!, payee), ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;
      }

      case "update_tags":
        await db
          .update(transactions)
          .set({ tags: encryptField(dek!, parsed.data.tags), ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "add_tag":
      case "remove_tag": {
        const wanted = toTagList(parsed.data.tag);
        const edit = action === "add_tag"
          ? (t: string) => addTags(t, wanted)
          : (t: string) => removeTags(t, wanted);
        const res = await rewriteTransactionTags({ executor: db, userId, dek, ids, transform: edit });
        if (res.changed > 0) invalidateUserTxCache(userId);
        return NextResponse.json({
          success: true,
          affected: res.changed,
          matched: res.scanned,
          ...(res.undecryptable > 0 ? { skippedUndecryptable: res.undecryptable } : {}),
        });
      }
    }

    invalidateUserTxCache(userId);
    return NextResponse.json({ success: true, affected: ids.length });
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await logApiError("POST", "/api/transactions/bulk", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Bulk operation failed") },
      { status: 500 }
    );
  }
}
