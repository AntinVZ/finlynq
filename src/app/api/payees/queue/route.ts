/**
 * /api/payees/queue — what waits for a decision in Merchants (P8 stage 1).
 *
 * GET → { clusters, needsDecision, lookalikes, drafts, suspicious,
 *         unrecognized, decisions }
 *   `decisions` is the menu badge (clusters + look-alikes + AI drafts +
 *   entries to check); `unrecognized` is a backlog shown in the queue only.
 *   Cached per user for two minutes and dropped on every directory change.
 *   Read only.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadQueueCounts } from "@/lib/payees/queue";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load the merchants queue" }, async ({ userId, dek }) => {
  const counts = await loadQueueCounts({ executor: db, userId, dek });
  return NextResponse.json(counts, { headers: { "Cache-Control": "private, max-age=30" } });
});
