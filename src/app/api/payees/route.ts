/**
 * /api/payees — Payee Studio overview (Merchants).
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
 *   totals), `batches` (the 20 newest change batches, with `canUndo`),
 *   `settings` and `draftCount` (AI proposals awaiting review).
 *   P6: `merchantTypes` (the dictionary, group → position; ids are null
 *   while it is the built-in starting set); each entity carries
 *   `merchantType` and, untyped, a `merchantTypeHint` (never applied).
 *   P6.2: `suspicious` — entries with a short / meaningless name to check
 *   (reasons, rows, spellings); entries marked as checked are left out.
 *   P5b: `lookalikeCount` (spellings that look like a directory entry and
 *   are not yet in it) and `unrenamedRows` (rows that already belong to an
 *   entry but still carry another spelling) — computed, nothing written. A group's `entityId` / `entityName` say which entity its
 *   spellings resolve to (unrecognized = none).
 *
 * POST { op, …, dryRun? } — directory change (create, update, alias_add,
 *   alias_remove, alias_from_rule, identifiers, merge, split, apply, delete,
 *   merchant_types, set_merchant_type, mark_reviewed, own_accounts, undo). `dryRun: true` runs the op in a rolled-back transaction and returns
 *   exactly what it would do (rows per table, spellings that change,
 *   conflicts, warnings, `blocked`); without it the op commits as one batch,
 *   undoable for 30 days. 400 bad input, 404 unknown id, 409 alias conflict /
 *   too many rows / undo blocked.
 *
 * Payees are encrypted per row, so everything happens in memory after
 * decryption (lib/payees) — no SQL text matching on payee.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadLookalikes, loadPayeeOverview, suspiciousOf } from "@/lib/payees/service";
import { listPayeeBatches } from "@/lib/payees/batches";
import { payeeErrorResponse } from "@/lib/payees/route-errors";
import { executePayeeOp, type PayeeOp } from "@/lib/payees/ops";
import { getPayeeSettings } from "@/lib/payees/settings";
import { PAYEE_TYPES } from "@/lib/payees/match-key";
import { ALIAS_MODES, IDENTIFIER_KINDS } from "@/lib/payees/directory";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load payees" }, async ({ request, userId, dek }) => {
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "");
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20_000) : 5_000;
  const overview = await loadPayeeOverview({ executor: db, userId, dek });
  const [batches, settings, drafts, lookalikes] = await Promise.all([
    listPayeeBatches(db, userId, { limit: 20 }),
    getPayeeSettings(db, userId),
    db.execute(sql`SELECT count(*)::int AS n FROM payee_proposals WHERE user_id = ${userId} AND status = 'draft'`),
    loadLookalikes({ executor: db, userId, dek, overview }),
  ]);
  return NextResponse.json({
    draftCount: Number((drafts as unknown as { rows: Array<{ n: number }> }).rows?.[0]?.n ?? 0),
    lookalikeCount: lookalikes.candidates.length,
    unrenamedRows: lookalikes.unrenamed.reduce((n, u) => n + u.rows, 0),
    entities: overview.entities,
    suspicious: suspiciousOf(overview),
    merchantTypes: overview.merchantTypes,
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
const details = {
  label: z.string().max(60).nullable().optional(),
  bank: z.string().max(60).nullable().optional(),
  currency: z.string().max(3).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional(),
};
const identifier = z.object({ kind: z.enum(IDENTIFIER_KINDS), value: z.string().min(1).max(200), ...details });
const dryRun = z.boolean().optional();
/** P6: a merchant type by id, "Група → Позиція" text, or { group, name }; null clears. */
const merchantType = z.union([id, z.string().min(1).max(170), z.object({ group: z.string().min(1).max(80), name: z.string().min(1).max(80) })]).nullable();
const typeEdit = { group: z.string().min(1).max(80), name: z.string().min(1).max(80).optional(), sort: z.number().int().min(0).max(1_000_000).optional(), defaultCategoryId: id.nullable().optional() };
const apply = z.boolean().optional();
/** P6.2: an own account / card ("Мої рахунки і картки"); a full card number is refused by the op. */
const ownAccount = {
  iban: z.string().max(40).nullable().optional(),
  card: z.string().max(30).nullable().optional(),
  bank: z.string().max(60).nullable().optional(),
  label: z.string().max(60).nullable().optional(),
  currency: z.string().max(3).nullable().optional(),
  owner: z.enum(["me", "spouse", "business"]).optional(),
};

const postSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name, type, note: z.string().max(2000).nullable().optional(), defaultCategoryId: id.nullable().optional(), website: z.string().max(500).nullable().optional(), merchantType: merchantType.optional(), aliases: z.array(alias).max(100).optional(), identifiers: z.array(identifier).max(20).optional(), apply, dryRun }),
  z.object({
    op: z.literal("update"),
    entityId: id,
    name: name.optional(),
    type,
    note: z.string().max(2000).nullable().optional(),
    defaultCategoryId: id.nullable().optional(),
    website: z.string().max(500).nullable().optional(),
    logo: z.string().max(40_000).nullable().optional(),
    merchantType: merchantType.optional(),
    apply,
    dryRun,
  }),
  z.object({
    op: z.literal("merchant_types"),
    add: z.array(z.object(typeEdit)).max(100).optional(),
    update: z.array(z.object({ id, ...typeEdit, group: typeEdit.group.optional() })).max(100).optional(),
    remove: z.array(id).max(100).optional(),
    dryRun,
  }),
  z.object({
    op: z.literal("set_merchant_type"),
    merchantType,
    entityIds: z.array(id).max(5000).optional(),
    typeWord: z.string().min(1).max(60).optional(),
    onlyUntyped: z.boolean().optional(),
    dryRun,
  }),
  z.object({ op: z.literal("alias_add"), entityId: id, aliases: z.array(alias).min(1).max(100), apply, dryRun }),
  z.object({ op: z.literal("alias_remove"), entityId: id, aliasIds: z.array(id).max(200).optional(), patterns: z.array(z.string().max(200)).max(200).optional(), dryRun }),
  z.object({ op: z.literal("alias_from_rule"), ruleId: id, entityId: id.optional(), apply, dryRun }),
  z.object({
    op: z.literal("identifiers"),
    entityId: id,
    add: z.array(identifier).max(20).optional(),
    update: z.array(z.object({ id, ...details })).max(50).optional(),
    deactivate: z.array(id).max(50).optional(),
    remove: z.array(id).max(50).optional(),
    dryRun,
  }),
  z.object({
    op: z.literal("merge"),
    into: z.union([z.object({ entityId: id }), z.object({ name, type, merchantType: merchantType.optional() })]),
    entityIds: z.array(id).max(200).optional(),
    payees: z.array(z.string().min(1).max(500)).max(500).optional(),
    apply,
    dryRun,
  }),
  z.object({ op: z.literal("split"), entityId: id, aliasIds: z.array(id).min(1).max(200), name, type, apply, dryRun }),
  z.object({ op: z.literal("apply"), entityIds: z.array(id).max(5000).optional(), dryRun }),
  z.object({ op: z.literal("delete"), entityId: id, dryRun }),
  z.object({ op: z.literal("apply_default_category"), entityId: id, categoryId: id.optional(), dryRun }),
  z.object({ op: z.literal("move_remainder"), entityId: id, payees: z.array(z.string().min(1).max(500)).min(1).max(100), remainder: z.string().min(1).max(200), target: z.enum(["tag", "note"]).optional(), dryRun }),
  z.object({ op: z.literal("mark_reviewed"), entityIds: z.array(id).min(1).max(500), reviewed: z.boolean().optional(), dryRun }),
  z.object({
    op: z.literal("own_accounts"),
    add: z.array(z.object(ownAccount)).max(50).optional(),
    update: z.array(z.object({ id, ...ownAccount })).max(50).optional(),
    remove: z.array(id).max(50).optional(),
    dryRun,
  }),
  z.object({ op: z.literal("undo"), batchId: id, dryRun }),
]);

export const POST = apiHandler(
  { auth: "encryption", locale: true, raw: true, body: postSchema, mapError: payeeErrorResponse, fallbackMessage: "Payee change failed" },
  async ({ userId, dek, body }) => {
    const { dryRun: isDry, ...op } = body;
    const result = await executePayeeOp({ executor: db, userId, dek: dek!, op: op as PayeeOp, actor: "web", dryRun: isDry === true });
    return NextResponse.json(result);
  },
);
