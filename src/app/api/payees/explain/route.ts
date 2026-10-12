/**
 * /api/payees/explain — "Why (not) clustered?" for two payees.
 *
 * GET ?a=<payee>&b=<payee>
 *   → { a, b: { payee, key, core, block, tokens, legalWords, type, entity,
 *       ambiguous }, sameKey, score: { confidence, reason } | null,
 *       verdict: same_name | clustered | separate | settled, reasons[] }
 *   Pure explanation of the clustering rules (lib/payees/explain.ts) plus
 *   which directory entry each payee resolves to. Read only.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { buildPayeeMatcher, loadDirectory } from "@/lib/payees/directory";
import { explainPayeePair } from "@/lib/payees/explain";

export const GET = apiHandler({ auth: "encryption", raw: true, fallbackMessage: "Failed to explain" }, async ({ request, userId, dek }) => {
  const params = request.nextUrl.searchParams;
  const a = (params.get("a") ?? "").trim().slice(0, 500);
  const b = (params.get("b") ?? "").trim().slice(0, 500);
  if (!a || !b) return NextResponse.json({ error: "Pass two payees: ?a=…&b=…" }, { status: 400 });
  const matcher = buildPayeeMatcher(dek ? await loadDirectory(db, userId, dek) : []);
  return NextResponse.json(explainPayeePair(a, b, matcher));
});
