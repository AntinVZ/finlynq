/**
 * /api/payees/amount-duplicates — the duplicates-by-amount queue (P8 stage 11).
 *
 * GET → { pairs: [{ id, a, b, matches, shared, needsDecision }], total, truncated }
 *   Two different payees paid the same amount on the same day at least
 *   twice. Read only; nothing is merged here.
 * POST { id, undo? } → { ok } — «Різні»: the pair is not offered again
 *   (or is offered again with `undo`).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { findAmountDuplicates, rejectAmountPair } from "@/lib/payees/amount-duplicates";
import { matcherFor } from "@/lib/payees/resolve-hint";
import { loadOwnMatcher } from "@/lib/payees/own-accounts";
import { getPayeeSettings, vocabularyOf } from "@/lib/payees/settings";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load duplicates by amount" }, async ({ userId, dek }) => {
  const [matcher, own, settings] = await Promise.all([matcherFor({ executor: db, userId, dek: dek! }), loadOwnMatcher(db, userId, dek), getPayeeSettings(db, userId)]);
  return NextResponse.json(await findAmountDuplicates({ executor: db, userId, dek, matcher, own, vocab: vocabularyOf(settings) }));
});

const postSchema = z.object({ id: z.string().min(1).max(2000), undo: z.boolean().optional() });

export const POST = apiHandler(
  { auth: "encryption", locale: true, raw: true, body: postSchema, fallbackMessage: "Failed to save the answer" },
  async ({ userId, dek, body }) => {
    const ok = await rejectAmountPair(db, userId, dek!, body.id, body.undo === true);
    return NextResponse.json({ ok }, { status: ok ? 200 : 400 });
  },
);
