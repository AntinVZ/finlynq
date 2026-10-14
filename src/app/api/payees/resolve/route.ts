/**
 * /api/payees/resolve — «Рекомендовано: X» for payee fields (P8 stage 4).
 *
 * GET ?payee=text → { kind: "match", entityId, name, via, same }
 *                 | { kind: "ambiguous", names } | { kind: "none" }
 *   The directory entry the text resolves to through its aliases; `same` =
 *   the text already is the canonical name. Read only.
 *
 * POST { payees: string[] (≤ 500) } → { results: { [payee]: recommendation } }
 *   for an import's rows; payees that resolve to nothing are left out.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { z } from "zod";
import { recommendPayee, recommendPayees } from "@/lib/payees/resolve-hint";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to resolve payee" }, async ({ request, userId, dek }) => {
  const payee = (request.nextUrl.searchParams.get("payee") ?? "").slice(0, 300);
  return NextResponse.json(await recommendPayee({ executor: db, userId, dek, payee }), { headers: { "Cache-Control": "private, max-age=30" } });
});

const postSchema = z.object({ payees: z.array(z.string().max(300)).max(500) });

export const POST = apiHandler({ auth: "encryption", locale: true, raw: true, body: postSchema, fallbackMessage: "Failed to resolve payees" }, async ({ userId, dek, body }) =>
  NextResponse.json({ results: await recommendPayees({ executor: db, userId, dek, payees: body.payees }) }),
);
