/**
 * /api/payees/[id] — one directory entity (Payee Studio entity page).
 *
 * GET → { entity: { id, name, type, note, defaultCategoryId, aliases,
 *   identifiers }, spellings: groups resolving to it (counts, totals, dates),
 *   pending: what "Apply" would rename now (rows per table, spellings),
 *   history: the entity's change batches (newest first, `canUndo`),
 *   categories: [{ id, name }] for the default-category picker, currency }.
 *
 * Identifiers are returned in full: this is the signed-in owner's own page
 * (MCP answers mask them). Read only.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadPayeeOverview } from "@/lib/payees/service";
import { listPayeeBatches } from "@/lib/payees/batches";
import { planPayeeApply } from "@/lib/payees/apply";
import { loadPayeeNameMaps } from "@/lib/payees/scan";

export const GET = apiHandler({ auth: "encryption", raw: true, fallbackMessage: "Failed to load payee" }, async ({ request, userId, dek }) => {
  const id = Number(request.nextUrl.pathname.split("/").filter(Boolean).pop());
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Bad entity id" }, { status: 400 });
  const overview = await loadPayeeOverview({ executor: db, userId, dek });
  const entity = overview.directory.find((e) => e.id === id);
  if (!entity) return NextResponse.json({ error: "Payee not found" }, { status: 404 });
  const [pending, history, names] = await Promise.all([
    planPayeeApply({ executor: db, userId, dek, matcher: overview.matcher, entityIds: new Set([id]) }),
    listPayeeBatches(db, userId, { entityId: id, limit: 100 }),
    loadPayeeNameMaps(db, userId, dek),
  ]);
  return NextResponse.json({
    entity,
    spellings: overview.groups.filter((g) => g.entityId === id).map(({ slices: _slices, ...g }) => g),
    pending: { total: pending.total, byTable: pending.byTable, changes: pending.changes.slice(0, 50), conflicts: pending.conflicts.slice(0, 20) },
    history,
    merchantTypes: overview.merchantTypes,
    merchantTypeHint: overview.entities.find((x) => x.id === id)?.merchantTypeHint ?? null,
    categories: [...names.categories.entries()].map(([cid, name]) => ({ id: cid, name })).sort((a, b) => a.name.localeCompare(b.name)),
    currency: overview.currency,
  });
});
