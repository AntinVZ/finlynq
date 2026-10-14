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
 * GET ?action=whose&q=<IBAN | card in any form | ІПН | ЄДРПОУ>  (P5g)
 *   → { query: { kind, masked, strength }, candidates: [{ entity, payee,
 *       evidence: directory|text|bank, holdsRequisite, transactions,
 *       firstDate, lastDate, totals (per currency), typicalAmount, accounts,
 *       examples (masked) }], hints, bankRows }  — 400 when q is not a
 *   requisite. A card's last 4 digits are weak: every candidate is listed.
 *
 * GET ?action=resolve&payee=<spelling> → { entity: { id, name, type } | null }
 *   Which directory entry a payee resolves to ("Add to payee" on a
 *   transaction).
 *
 * POST { action: "propose", refs: string[] } → { saved, rejected, missing }
 *   Stores the chosen suggestions / links as DRAFT proposals (encrypted),
 *   which a person approves on Merchants → AI review. Nothing in the
 *   directory or the ledger changes here.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { buildPayeeMatcher, loadDirectory } from "@/lib/payees/directory";
import { mineIdentifiers, mineReportOut, proposeMined } from "@/lib/payees/mine";
import { payeeErrorResponse } from "@/lib/payees/route-errors";
import { findWhose } from "@/lib/payees/whose";
import { identifierQueryRefusal } from "@/lib/payees/requisites";
import { loadPayeeNameMaps, spellingOf } from "@/lib/payees/scan";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to look for requisites" }, async ({ request, userId, dek }) => {
  const params = request.nextUrl.searchParams;
  const action = params.get("action");
  if (action === "whose") {
    // P6.2: a full card number is refused before anything is looked up.
    const refusal = identifierQueryRefusal(params.get("q") ?? "");
    if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
    const { accounts } = await loadPayeeNameMaps(db, userId, dek);
    const report = await findWhose({ executor: db, userId, dek, identifier: (params.get("q") ?? "").slice(0, 100), accountNames: accounts });
    if (!report) return NextResponse.json({ error: "Type an IBAN, a card (last 4 digits or a mask), a 10-digit ІПН or an 8-digit ЄДРПОУ." }, { status: 400 });
    return NextResponse.json(report);
  }
  if (action === "resolve") {
    const directory = await loadDirectory(db, userId, dek);
    const m = buildPayeeMatcher(directory).match(spellingOf(params.get("payee") ?? ""));
    const e = m.kind === "match" ? directory.find((x) => x.id === m.entityId) : undefined;
    return NextResponse.json({ entity: e ? { id: e.id, name: e.name, type: e.type } : null });
  }
  if (action !== "mine") return NextResponse.json({ error: "Pass action=mine, whose or resolve." }, { status: 400 });
  const raw = Number(params.get("limit") ?? "");
  const directory = await loadDirectory(db, userId, dek);
  const report = await mineIdentifiers({ executor: db, userId, dek, matcher: buildPayeeMatcher(directory), directory, limit: Number.isInteger(raw) && raw > 0 ? Math.min(raw, 1000) : 200 });
  return NextResponse.json(mineReportOut(report));
});

const postSchema = z.object({ action: z.literal("propose"), refs: z.array(z.string().regex(/^r_[A-Za-z0-9_-]{16}$/)).min(1).max(200) });

export const POST = apiHandler(
  { auth: "encryption", locale: true, raw: true, body: postSchema, mapError: payeeErrorResponse, fallbackMessage: "Failed to save the suggestions" },
  async ({ userId, dek, body }) => {
    const directory = await loadDirectory(db, userId, dek);
    const report = await mineIdentifiers({ executor: db, userId, dek, matcher: buildPayeeMatcher(directory), directory, limit: 5000 });
    const res = await proposeMined({ executor: db, userId, dek: dek!, report, refs: body.refs, source: "mine" });
    return NextResponse.json({ saved: res.saved, rejected: res.rejected, missing: res.missing });
  },
);
