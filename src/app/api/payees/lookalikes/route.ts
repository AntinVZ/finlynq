/**
 * /api/payees/lookalikes — new spellings that look like a directory entry
 * (Payee Studio P5b; Merchants → Queue → Other spellings, "Check for new
 * look-alikes").
 *
 * GET ?limit=N (default 500)
 *   → { candidates: [{ key, name, spellings, count, total, lastDate,
 *       entity: { id, name, type }, confidence, reason, matchedAlias,
 *       needsDecision, decisionReason, remainder, alternatives }],
 *       unrenamed: [{ entityId, entityName, spellings, rows }],
 *       rejections: [{ id, entityId, entityName, payee, createdAt }],
 *       rejectedHidden, currency }
 *   Read only: computed on request from the payee scan — no schedule.
 *
 * POST { action: "reject", payee, entityId } — "Different payee": remember
 *   the pair so it is not suggested again (HMAC of the matching key).
 * POST { action: "unreject", id } | { action: "unreject", payee, entityId }
 *   — cancel a remembered answer.
 * The other two answers are ordinary payee ops on POST /api/payees:
 *   "Same payee" = alias_add; "Same payee, move the rest to a tag or note" =
 *   move_remainder (both previewed, one undoable batch).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadLookalikes, loadPayeeOverview } from "@/lib/payees/service";
import { cancelRejection, rejectLookalike } from "@/lib/payees/lookalikes";
import { payeeErrorResponse } from "@/lib/payees/route-errors";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to check look-alikes" }, async ({ request, userId, dek }) => {
  const raw = Number(request.nextUrl.searchParams.get("limit") ?? "");
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 5000) : 500;
  const overview = await loadPayeeOverview({ executor: db, userId, dek });
  const report = await loadLookalikes({ executor: db, userId, dek, overview, limit });
  return NextResponse.json({ ...report, currency: overview.currency });
});

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reject"), payee: z.string().min(1).max(500), entityId: z.number().int().positive() }),
  z.object({
    action: z.literal("unreject"),
    id: z.number().int().positive().optional(),
    payee: z.string().min(1).max(500).optional(),
    entityId: z.number().int().positive().optional(),
  }),
]);

export const POST = apiHandler(
  { auth: "encryption", locale: true, raw: true, body: postSchema, mapError: payeeErrorResponse, fallbackMessage: "Look-alike update failed" },
  async ({ userId, dek, body }) => {
    if (body.action === "reject") {
      const ok = await rejectLookalike(db, userId, dek!, body.payee, body.entityId);
      if (!ok) return NextResponse.json({ error: "Payee not found" }, { status: 404 });
      return NextResponse.json({ rejected: true });
    }
    if (body.id != null) return NextResponse.json({ removed: await cancelRejection(db, userId, dek!, { id: body.id }) });
    if (body.payee && body.entityId != null) return NextResponse.json({ removed: await cancelRejection(db, userId, dek!, { payee: body.payee, entityId: body.entityId }) });
    return NextResponse.json({ error: "Pass id, or payee and entityId." }, { status: 400 });
  },
);
