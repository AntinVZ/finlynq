/**
 * /api/payees/[id] — one directory entity (Payee Studio entity page).
 *
 * GET → { entity: { id, name, type, note, defaultCategoryId, aliases,
 *   identifiers }, spellings: groups resolving to it (counts, totals, dates),
 *   pending: what "Apply" would rename now (rows per table, spellings),
 *   history: the entity's change batches (newest first, `canUndo`),
 *   categories: [{ id, name }] for the default-category picker, currency,
 *   kpis (P8): the last 12 months — total, spend, count, average payment,
 *   last date, a monthly series — and the most recent transactions }.
 *
 * Identifiers are returned in full: this is the signed-in owner's own page
 * (MCP answers mask them). Read only.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadPayeeOverview, makeSliceConverter } from "@/lib/payees/service";
import { loadMerchantKpis } from "@/lib/payees/merchant-profile";
import { listPayeeBatches } from "@/lib/payees/batches";
import { planPayeeApply } from "@/lib/payees/apply";
import { loadPayeeNameMaps } from "@/lib/payees/scan";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load payee" }, async ({ request, userId, dek }) => {
  const id = Number(request.nextUrl.pathname.split("/").filter(Boolean).pop());
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Bad entity id" }, { status: 400 });
  const overview = await loadPayeeOverview({ executor: db, userId, dek });
  const entity = overview.directory.find((e) => e.id === id);
  if (!entity) return NextResponse.json({ error: "Payee not found" }, { status: 404 });
  const [pending, history, names, converter] = await Promise.all([
    planPayeeApply({ executor: db, userId, dek, matcher: overview.matcher, entityIds: new Set([id]) }),
    listPayeeBatches(db, userId, { entityId: id, limit: 100 }),
    loadPayeeNameMaps(db, userId, dek),
    makeSliceConverter(userId, overview.currency),
  ]);
  const keys = new Set(overview.groups.filter((g) => g.entityId === id && g.key).map((g) => g.key));
  const kpis = await loadMerchantKpis({ executor: db, userId, dek, keys, convert: converter.convert, currency: converter.currency, names });
  return NextResponse.json({
    entity,
    spellings: overview.groups.filter((g) => g.entityId === id).map(({ slices: _slices, ...g }) => g),
    pending: { total: pending.total, byTable: pending.byTable, changes: pending.changes.slice(0, 50), conflicts: pending.conflicts.slice(0, 20) },
    history,
    merchantTypes: overview.merchantTypes,
    merchantTypeHint: overview.entities.find((x) => x.id === id)?.merchantTypeHint ?? null,
    merchantTypeMixed: overview.entities.find((x) => x.id === id)?.merchantTypeMixed ?? null,
    categories: [...names.categories.entries()].map(([cid, name]) => ({ id: cid, name })).sort((a, b) => a.name.localeCompare(b.name)),
    currency: overview.currency,
    kpis,
  });
});
