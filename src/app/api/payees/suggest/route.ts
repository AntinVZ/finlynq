/**
 * /api/payees/suggest — hints for payee input boxes (PayeeCombobox).
 *
 * GET ?q=text&limit=1..50 (default 10)
 *   → { suggestions: [{ value, label, kind: entity|alias|recent, entityId,
 *       entityName, type, count? }] }
 *   Directory canonical names, their aliases (the value is the canonical
 *   name) and recent distinct payees. Free text stays allowed in the box.
 *   Built from the directory and the cached decrypted transactions — one
 *   build per user per minute (lib/payees/suggest.ts), no per-row queries.
 *   Read only.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { suggestPayees } from "@/lib/payees/service";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load payee suggestions" }, async ({ request, userId, dek }) => {
  const params = request.nextUrl.searchParams;
  const q = (params.get("q") ?? "").slice(0, 200);
  const raw = Number(params.get("limit") ?? "");
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 50) : 10;
  const suggestions = await suggestPayees({ executor: db, userId, dek, q, limit });
  return NextResponse.json({ suggestions }, { headers: { "Cache-Control": "private, max-age=30" } });
});
