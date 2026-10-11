/**
 * /api/payees — Payee Studio overview (Settings → Payees).
 *
 * GET ?limit=N (default 5000)
 *   → { groups, clusters, currency, scanned, truncated, undecryptable, totalGroups }
 *   Every payee of the user, read from transactions, recurring, staged,
 *   SimpleFIN pending and the bank ledger (read only), decrypted and folded:
 *   `groups` are spellings with the same matching key (case, apostrophes,
 *   Latin/Cyrillic transliteration and card-terminal noise ignored);
 *   `clusters` reference groups by `keys` and carry a confidence, the
 *   reasons, and `needsDecision` for private persons / sole proprietors.
 *   `total` is the signed sum of the group's transactions in the display
 *   currency.
 *
 *   Also: `entities` (the directory, with resolved transaction counts and
 *   totals), `batches` (the 20 newest change batches, with `canUndo`) and
 *   `settings`. A group's `entityId` / `entityName` say which entity its
 *   spellings resolve to (unrecognized = none).
 *
 * POST { op, …, dryRun? } — directory change (create, update, alias_add,
 *   alias_remove, alias_from_rule, identifiers, merge, split, apply, delete,
 *   undo). `dryRun: true` runs the op in a rolled-back transaction and returns
 *   exactly what it would do (rows per table, spellings that change,
 *   conflicts, warnings, `blocked`); without it the op commits as one batch,
 *   undoable for 30 days. 400 bad input, 404 unknown id, 409 alias conflict /
 *   too many rows / undo blocked.
 *
 * Payees are encrypted per row, so everything happens in memory after
 * decryption (lib/payees) — no SQL text matching on payee.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadPayeeOverview } from "@/lib/payees/service";
import { listPayeeBatches } from "@/lib/payees/batches";
import { payeeErrorResponse } from "@/lib/payees/route-errors";
import { executePayeeOp, type PayeeOp } from "@/lib/payees/ops";
import { getPayeeSettings } from "@/lib/payees/settings";
import { PAYEE_TYPES } from "@/lib/payees/match-key";
import { ALIAS_MODES, IDENTIFIER_KINDS } from "@/lib/payees/directory";

export const GET = apiHandler({ auth: "encryption", raw: true, fallbackMessage: "Failed to load payees" }, async ({ request, userId, dek }) => {
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20_000) : 5_000;
  const overview = await loadPayeeOverview({ executor: db, userId, dek });
  const [batches, settings] = await Promise.all([listPayeeBatches(db, userId, { limit: 20 }), getPayeeSettings(db, userId)]);
  return NextResponse.json({
    entities: overview.entities,
    batches,
    settings,
    groups: overview.groups.slice(0, limit).map(({ slices: _slices, ...g }) => g),
    totalGroups: overview.groups.length,
    clusters: overview.clusters.map(({ groups: _groups, ...c }) => c),
    currency: overview.currency,
    scanned: overview.scanned,
    truncated: overview.truncated,
    undecryptable: overview.undecryptable,
  });
});

const name = z.string().min(1).max(200);
const type = z.enum(PAYEE_TYPES).optional();
const id = z.number().int().positive();
const alias = z.object({ pattern: z.string().min(1).max(200), mode: z.enum(ALIAS_MODES).optional() });
const identifier = z.object({ kind: z.enum(IDENTIFIER_KINDS), value: z.string().min(1).max(200) });
const dryRun = z.boolean().optional();
const apply = z.boolean().optional();

const postSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name, type, note: z.string().max(2000).nullable().optional(), defaultCategoryId: id.nullable().optional(), aliases: z.array(alias).max(100).optional(), identifiers: z.array(identifier).max(20).optional(), apply, dryRun }),
  z.object({ op: z.literal("update"), entityId: id, name: name.optional(), type, note: z.string().max(2000).nullable().optional(), defaultCategoryId: id.nullable().optional(), apply, dryRun }),
  z.object({ op: z.literal("alias_add"), entityId: id, aliases: z.array(alias).min(1).max(100), apply, dryRun }),
  z.object({ op: z.literal("alias_remove"), entityId: id, aliasIds: z.array(id).max(200).optional(), patterns: z.array(z.string().max(200)).max(200).optional(), dryRun }),
  z.object({ op: z.literal("alias_from_rule"), ruleId: id, entityId: id.optional(), apply, dryRun }),
  z.object({ op: z.literal("identifiers"), entityId: id, add: z.array(identifier).max(20).optional(), remove: z.array(id).max(50).optional(), dryRun }),
  z.object({
    op: z.literal("merge"),
    into: z.union([z.object({ entityId: id }), z.object({ name, type })]),
    entityIds: z.array(id).max(200).optional(),
    payees: z.array(z.string().min(1).max(500)).max(500).optional(),
    apply,
    dryRun,
  }),
  z.object({ op: z.literal("split"), entityId: id, aliasIds: z.array(id).min(1).max(200), name, type, apply, dryRun }),
  z.object({ op: z.literal("apply"), entityIds: z.array(id).max(5000).optional(), dryRun }),
  z.object({ op: z.literal("delete"), entityId: id, dryRun }),
  z.object({ op: z.literal("undo"), batchId: id, dryRun }),
]);

export const POST = apiHandler(
  { auth: "encryption", raw: true, body: postSchema, mapError: payeeErrorResponse, fallbackMessage: "Payee change failed" },
  async ({ userId, dek, body }) => {
    const { dryRun: isDry, ...op } = body;
    const result = await executePayeeOp({ executor: db, userId, dek: dek!, op: op as PayeeOp, actor: "web", dryRun: isDry === true });
    return NextResponse.json(result);
  },
);
