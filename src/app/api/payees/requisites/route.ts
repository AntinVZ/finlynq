/**
 * /api/payees/requisites — requisite mining (Payee Studio P5f).
 *
 * GET ?action=mine[&limit=N] → { suggestions, links, scanned, truncated }
 *   Scans transactions (payee + note) and the bank ledger's statement text
 *   (read only) for IBANs, card masks / numbers (last 4 digits only) and
 *   signed ЄДРПОУ / ІПН codes; everything comes back MASKED. Runs only when
 *   asked (a button), never on a schedule. `links` = a strong requisite of a
 *   directory entry found in rows of another payee.
 *
 * POST { action: "propose", refs: string[] } → { saved, rejected, missing }
 *   Stores the chosen suggestions / links as DRAFT proposals (encrypted),
 *   which a person approves on Settings → Payees → AI review. Nothing in the
 *   directory or the ledger changes here.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { buildPayeeMatcher, loadDirectory } from "@/lib/payees/directory";
import { mineIdentifiers, mineReportOut, proposeMined } from "@/lib/payees/mine";
import { payeeErrorResponse } from "@/lib/payees/route-errors";

export const GET = apiHandler({ auth: "encryption", raw: true, fallbackMessage: "Failed to look for requisites" }, async ({ request, userId, dek }) => {
  const params = request.nextUrl.searchParams;
  if (params.get("action") !== "mine") return NextResponse.json({ error: "Pass action=mine." }, { status: 400 });
  const raw = Number(params.get("limit") ?? "");
  const directory = await loadDirectory(db, userId, dek);
  const report = await mineIdentifiers({ executor: db, userId, dek, matcher: buildPayeeMatcher(directory), directory, limit: Number.isInteger(raw) && raw > 0 ? Math.min(raw, 1000) : 200 });
  return NextResponse.json(mineReportOut(report));
});

const postSchema = z.object({ action: z.literal("propose"), refs: z.array(z.string().regex(/^r_[A-Za-z0-9_-]{16}$/)).min(1).max(200) });

export const POST = apiHandler(
  { auth: "encryption", raw: true, body: postSchema, mapError: payeeErrorResponse, fallbackMessage: "Failed to save the suggestions" },
  async ({ userId, dek, body }) => {
    const directory = await loadDirectory(db, userId, dek);
    const report = await mineIdentifiers({ executor: db, userId, dek, matcher: buildPayeeMatcher(directory), directory, limit: 5000 });
    const res = await proposeMined({ executor: db, userId, dek: dek!, report, refs: body.refs, source: "mine" });
    return NextResponse.json({ saved: res.saved, rejected: res.rejected, missing: res.missing });
  },
);
