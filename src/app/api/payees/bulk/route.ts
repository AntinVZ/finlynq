/**
 * /api/payees/bulk — bulk registry fill (Payee Studio P6.2, item 82 / B28).
 *
 * GET ?threshold=0.9 → { threshold, rows, people, left, max }
 *   `rows`: look-alike clusters at or above the threshold without "needs
 *   decision", and single unrecognized payees — name, merchant-type HINT
 *   (never applied by itself), spellings, row count. `people`: persons and
 *   ФОП, never part of a set (decided one by one).
 * POST { items: [{ rowId, name?, merchantType? }], dryRun? } → one preview /
 *   ONE batch (30-day undo): each row becomes a directory entry, its
 *   spellings exact aliases, the type only when given. Stored payees are not
 *   renamed: `bulk.pendingRows` says how many a later Apply would rewrite.
 *   409 too many rows, 404 rows gone (refresh), 400 a person — plain messages.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadPayeeOverview } from "@/lib/payees/service";
import { BULK_DEFAULT_THRESHOLD, BULK_MAX, buildBulkCandidates, commitBulkRegistry } from "@/lib/payees/bulk-registry";
import { payeeErrorResponse } from "@/lib/payees/route-errors";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load candidates" }, async ({ request, userId, dek }) => {
  const raw = Number(request.nextUrl.searchParams.get("threshold") ?? "");
  const threshold = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : BULK_DEFAULT_THRESHOLD;
  const overview = await loadPayeeOverview({ executor: db, userId, dek });
  return NextResponse.json({ ...buildBulkCandidates(overview, { threshold }), max: BULK_MAX });
});

const merchantType = z.union([z.number().int().positive(), z.string().min(1).max(170), z.object({ group: z.string().min(1).max(80), name: z.string().min(1).max(80) })]).nullable();
const postSchema = z.object({
  // A size over BULK_MAX is refused by commitBulkRegistry with a plain message, so the schema allows a little more.
  items: z.array(z.object({ rowId: z.string().min(1).max(80), name: z.string().min(1).max(200).optional(), merchantType: merchantType.optional() })).min(1).max(5000),
  dryRun: z.boolean().optional(),
});

export const POST = apiHandler(
  { auth: "encryption", locale: true, raw: true, body: postSchema, mapError: payeeErrorResponse, fallbackMessage: "Bulk fill failed" },
  async ({ userId, dek, body }) => {
    const overview = await loadPayeeOverview({ executor: db, userId, dek });
    const result = await commitBulkRegistry({ executor: db, userId, dek: dek!, overview, items: body.items, actor: "web", dryRun: body.dryRun === true });
    return NextResponse.json(result);
  },
);
