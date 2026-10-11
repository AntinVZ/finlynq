/**
 * /api/payees/proposals — AI proposals awaiting a decision (Settings →
 * Payees → AI review).
 *
 * GET ?status=draft|approved|rejected|all (default draft)
 *   → { proposals: [{ id, canonical, type, entityId, aliases, identifiers,
 *       reason, confidence, needsDecision, notes, status, batchId, … }] }
 *   Drafts are submitted by an AI client over MCP (`manage_payees
 *   op=propose`) and change nothing until approved here.
 *
 * POST { action: "approve", ids, dryRun? } — all chosen drafts as ONE payee
 *   batch (undoable for 30 days; undoing returns them to draft). `dryRun`
 *   previews rows per table without writing.
 * POST { action: "reject", ids } → { rejected }.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { approveProposals, listProposals, rejectProposals } from "@/lib/payees/proposals";
import { payeeErrorResponse } from "@/lib/payees/route-errors";

export const GET = apiHandler({ auth: "encryption", raw: true, fallbackMessage: "Failed to load proposals" }, async ({ request, userId, dek }) => {
  const raw = request.nextUrl.searchParams.get("status");
  const status = raw === "approved" || raw === "rejected" || raw === "all" ? raw : "draft";
  return NextResponse.json({ proposals: await listProposals(db, userId, dek, { status, limit: 1000 }) });
});

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), ids: z.array(z.number().int().positive()).min(1).max(100), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("reject"), ids: z.array(z.number().int().positive()).min(1).max(1000) }),
]);

export const POST = apiHandler(
  { auth: "encryption", raw: true, body: postSchema, mapError: payeeErrorResponse, fallbackMessage: "Proposal update failed" },
  async ({ userId, dek, body }) => {
    if (body.action === "reject") return NextResponse.json({ rejected: await rejectProposals(db, userId, body.ids) });
    const res = await approveProposals({ executor: db, userId, dek: dek!, ids: body.ids, actor: "web", dryRun: body.dryRun === true });
    return NextResponse.json({ ...res.result, approved: res.approved });
  },
);
