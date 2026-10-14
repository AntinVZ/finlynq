/**
 * /api/payees/search — the Merchants search box (Ctrl/Cmd+K, P8 stage 1).
 *
 * GET ?q=text&limit=1..50 (default 12)
 *   → { hits: [{ kind: entity|alias|recent|requisite, label, entityId,
 *       entityName, type, detail, count? }], requisite, own, refusal }
 *   A name, an alias or a recent spelling; or a requisite (IBAN, a card's
 *   last 4 digits or a mask, ІПН / ЄДРПОУ) — `requisite` is then its masked
 *   form and strength, `own` says it is one of your own accounts. A full
 *   card number is refused (`refusal`), never searched. Read only.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { searchMerchants } from "@/lib/payees/search";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Search failed" }, async ({ request, userId, dek }) => {
  const params = request.nextUrl.searchParams;
  const raw = Number(params.get("limit") ?? "");
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 50) : 12;
  const result = await searchMerchants({ executor: db, userId, dek, q: params.get("q") ?? "", limit });
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
});
