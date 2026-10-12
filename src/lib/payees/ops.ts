/**
 * Payee directory operations (Payee Studio P2) shared by `POST /api/payees`
 * and MCP `manage_payees`.
 *
 * Every op runs as ONE payee batch (./batches.ts) in ONE DB transaction:
 * directory change first, then — when `apply` is on — the payee rewrite of
 * the affected entities (./apply.ts), journaled for a 30-day undo.
 *
 * Preview = the same code in a transaction that is rolled back (`dryRun`),
 * so a preview reports exactly what the commit will do: aliases added, rows
 * per table, the spellings that change, conflicts and warnings. Callers
 * commit with a second call (web: after the confirm dialog; MCP: with the
 * confirmation token bound to the preview's fingerprint).
 *
 * Limits: an apply over PAYEE_APPLY_MAX_ROWS rows, or over a scan that
 * stopped early, is refused (the preview says `blocked`).
 */
import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { decryptRuleFields } from "@/lib/rules/crypto";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { guessPayeeType, payeeMatchKey, PAYEE_TYPES, type PayeeType } from "./match-key";
import {
  ALIAS_MODES,
  buildPayeeMatcher,
  exactAliasOwners,
  IDENTIFIER_KINDS,
  insertAlias,
  insertEntity,
  insertIdentifier,
  loadDirectory,
  maskIdentifier,
  normalizeIdentifier,
  PayeeDirectoryError,
  updateEntityRow,
  validateAlias,
  validateEntityName,
  type AliasMode,
  type IdentifierKind,
  type PayeeEntity,
} from "./directory";
import { inTransaction, PayeeBatchError, runPayeeBatch, undoPayeeBatch, writeStoredPayees, writeTransactionColumn, type BatchActor, type RewriteTable, type UndoResult } from "./batches";
import { encryptField } from "@/lib/crypto/envelope";
import { normalizeLogo, normalizeWebsite } from "./profile";
import { addTags } from "@/lib/tags";
import { decodeStoredPayee, spellingOf } from "./scan";
import { PAYEE_APPLY_MAX_ROWS, planFingerprint, planPayeeApply, runPayeeApply, type ApplyPlan } from "./apply";
import type { PayeeExecutor } from "./scan";
import { invalidatePayeeSuggest } from "./suggest";

export type AliasInput = { pattern: string; mode?: AliasMode };
export type IdentifierInput = { kind: IdentifierKind; value: string };

export type PayeeOp =
  | { op: "create"; name: string; type?: PayeeType; note?: string | null; defaultCategoryId?: number | null; website?: string | null; aliases?: AliasInput[]; identifiers?: IdentifierInput[]; apply?: boolean }
  /** P5c: `website` / `logo` (null clears) — the merchant profile. */
  | { op: "update"; entityId: number; name?: string; type?: PayeeType; note?: string | null; defaultCategoryId?: number | null; website?: string | null; logo?: string | null; apply?: boolean }
  | { op: "alias_add"; entityId: number; aliases: AliasInput[]; apply?: boolean }
  | { op: "alias_remove"; entityId: number; aliasIds?: number[]; patterns?: string[] }
  | { op: "alias_from_rule"; ruleId: number; entityId?: number; apply?: boolean }
  | { op: "identifiers"; entityId: number; add?: IdentifierInput[]; remove?: number[] }
  | { op: "merge"; into: { entityId: number } | { name: string; type?: PayeeType }; entityIds?: number[]; payees?: string[]; apply?: boolean }
  | { op: "split"; entityId: number; aliasIds: number[]; name: string; type?: PayeeType; apply?: boolean }
  | { op: "apply"; entityIds?: number[] }
  /**
   * P5b look-alike action (2): "same payee, move the rest to a tag or note".
   * Every `transactions` row whose payee has the matching key of one of
   * `payees` gets the entity's canonical name, and `remainder` is added to
   * its tags (default) or appended to its note. Journaled (payee + tags /
   * note) for the 30-day undo. No alias is added: the remainder is per row.
   */
  | { op: "move_remainder"; entityId: number; payees: string[]; remainder: string; target?: "tag" | "note" }
  | { op: "delete"; entityId: number }
  | { op: "undo"; batchId: number }
  /** Several ops as ONE batch (e.g. approving AI proposals). `kind` labels the batch. */
  | { op: "bulk"; kind: string; ops: SingleOp[]; aliasSource?: string; labels?: string[] };

/** Ops that can run inside a bulk batch. */
export type SingleOp = Exclude<PayeeOp, { op: "undo" } | { op: "bulk" }>;

export type PayeeOpResult = {
  op: PayeeOp["op"];
  dryRun: boolean;
  batchId: number | null;
  entity: { id: number; name: string; type: PayeeType } | null;
  created: boolean;
  aliasesAdded: Array<{ pattern: string; mode: AliasMode }>;
  aliasesRemoved: number;
  identifiersAdded: Array<{ kind: IdentifierKind; masked: string }>;
  identifiersRemoved: number;
  entitiesRemoved: number;
  rows: {
    total: number;
    byTable: Record<RewriteTable, number>;
    changes: ApplyPlan["changes"];
    conflicts: ApplyPlan["conflicts"];
    truncated: boolean;
  };
  undo?: UndoResult;
  warnings: string[];
  /** Why the op can't be committed as is (too many rows, truncated scan). */
  blocked: string | null;
  /** Binds an MCP confirmation token to exactly these rows. */
  fingerprint: string;
};

class DryRunRollback extends Error {
  constructor(public readonly result: PayeeOpResult) {
    super("dry run");
  }
}

const emptyRows = (): PayeeOpResult["rows"] => ({ total: 0, byTable: { transactions: 0, recurring: 0, staged: 0 }, changes: [], conflicts: [], truncated: false });

function entityOf(entities: PayeeEntity[], id: number): PayeeEntity {
  const e = entities.find((x) => x.id === id);
  if (!e) throw new PayeeDirectoryError(`No payee entity #${id}.`, "not_found");
  return e;
}

const PERSON_ENTITY_TYPES = new Set<PayeeType>(["person", "sole_proprietor"]);

const asType = (t: string | undefined, fallbackName: string): PayeeType =>
  t && (PAYEE_TYPES as readonly string[]).includes(t) ? (t as PayeeType) : guessPayeeType(fallbackName).type;

const asMode = (m: string | undefined): AliasMode => (m && (ALIAS_MODES as readonly string[]).includes(m) ? (m as AliasMode) : "exact");

/** Refuse an exact alias another entity (outside `allowedOwners`) already owns. */
function assertExactFree(entities: PayeeEntity[], pattern: string, selfId: number | undefined, allowedOwners: ReadonlySet<number> = new Set()): void {
  const owners = exactAliasOwners(entities, pattern, selfId).filter((o) => !allowedOwners.has(o.id));
  if (owners.length) {
    throw new PayeeDirectoryError(
      `"${pattern}" already belongs to "${owners[0].name}" (#${owners[0].id}). Merge the two, or remove that alias first.`,
      "alias_conflict",
    );
  }
}

/**
 * Plan or run one op. `dryRun` runs everything in a transaction and rolls it
 * back. Throws PayeeDirectoryError / PayeeBatchError for a bad request.
 */
export async function executePayeeOp(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer;
  op: PayeeOp;
  actor: BatchActor;
  dryRun?: boolean;
  /** Runs inside the same transaction once the batch is written (also in a dry run, then rolled back). */
  onBatch?: (tx: PayeeExecutor, result: PayeeOpResult) => Promise<void>;
}): Promise<PayeeOpResult> {
  const { executor, userId, dek, op, actor } = opts;
  const dryRun = opts.dryRun === true;
  if (dryRun && typeof (executor as { transaction?: unknown }).transaction !== "function") {
    throw new Error("A payee preview needs a database connection with transactions.");
  }
  try {
    const result = await inTransaction(executor, async (tx) => {
      const out = op.op === "undo" ? await runUndo(tx, userId, dek, op.batchId, dryRun) : await runOp(tx, userId, dek, op, actor, dryRun);
      if (opts.onBatch && !out.blocked) await opts.onBatch(tx, out);
      if (dryRun) throw new DryRunRollback(out);
      if (out.blocked) throw new PayeeDirectoryError(out.blocked, "too_large");
      return out;
    });
    if (result.rows.byTable.transactions > 0 || (result.undo?.restoredRows ?? 0) > 0) invalidateUserTxCache(userId);
    invalidatePayeeSuggest(userId);
    return result;
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result;
    throw e;
  }
}

async function runUndo(tx: PayeeExecutor, userId: string, dek: Buffer, batchId: number, dryRun: boolean): Promise<PayeeOpResult> {
  const undo = await undoPayeeBatch({ executor: tx, userId, dek, batchId });
  return {
    op: "undo",
    dryRun,
    batchId,
    entity: null,
    created: false,
    aliasesAdded: [],
    aliasesRemoved: 0,
    identifiersAdded: [],
    identifiersRemoved: 0,
    entitiesRemoved: undo.removedEntities,
    rows: { ...emptyRows(), total: undo.restoredRows },
    undo,
    warnings: undo.skippedRows ? [`${undo.skippedRows} row(s) were changed after this batch and are left as they are.`] : [],
    blocked: null,
    fingerprint: `undo:${batchId}`,
  };
}

async function runOp(
  tx: PayeeExecutor,
  userId: string,
  dek: Buffer,
  root: Exclude<PayeeOp, { op: "undo" }>,
  actor: BatchActor,
  dryRun: boolean,
): Promise<PayeeOpResult> {
  const out: PayeeOpResult = {
    op: root.op,
    dryRun,
    batchId: null,
    entity: null,
    created: false,
    aliasesAdded: [],
    aliasesRemoved: 0,
    identifiersAdded: [],
    identifiersRemoved: 0,
    entitiesRemoved: 0,
    rows: emptyRows(),
    warnings: [],
    blocked: null,
    fingerprint: "",
  };
  const kind = root.op === "bulk" ? root.kind : root.op;
  /** Alias source label: a bulk batch may override it (e.g. "proposal"). */
  const src = (fallback: string) => (root.op === "bulk" && root.aliasSource ? root.aliasSource : fallback);
  const { batchId } = await runPayeeBatch({ executor: tx, userId, dek, kind, actor }, async (btx, journal) => {
    const entities: PayeeEntity[] = [];
    /** Entities whose payees get rewritten afterwards. */
    const applyTo: number[] = [];

    const addAliases = async (entityId: number, aliases: AliasInput[], source: string, allowedOwners?: ReadonlySet<number>) => {
      const self = entities.find((e) => e.id === entityId);
      for (const a of aliases) {
        const mode = asMode(a.mode);
        const pattern = validateAlias(a.pattern, mode);
        if (mode === "exact") {
          assertExactFree(entities, pattern, entityId, allowedOwners);
          if (self?.aliases.some((x) => x.mode === "exact" && payeeMatchKey(x.pattern) === payeeMatchKey(pattern))) continue;
          if (out.aliasesAdded.some((x) => x.mode === "exact" && payeeMatchKey(x.pattern) === payeeMatchKey(pattern))) continue;
        } else if (self?.aliases.some((x) => x.mode === mode && x.pattern === pattern)) {
          continue;
        }
        await insertAlias(btx, userId, dek, { entityId, pattern, mode, source });
        out.aliasesAdded.push({ pattern, mode });
        journal.count("aliases_added");
      }
    };
    const addIdentifiers = async (entityId: number, ids: IdentifierInput[]) => {
      const self = entities.find((e) => e.id === entityId);
      for (const i of ids) {
        if (!(IDENTIFIER_KINDS as readonly string[]).includes(i.kind)) throw new PayeeDirectoryError(`Unknown identifier kind "${i.kind}".`);
        const value = normalizeIdentifier(i.kind, i.value);
        if (self?.identifiers.some((x) => x.kind === i.kind && x.value === value)) continue;
        if (out.identifiersAdded.some((x) => x.kind === i.kind && x.masked === maskIdentifier(i.kind, value))) continue;
        await insertIdentifier(btx, userId, dek, { entityId, kind: i.kind, value });
        out.identifiersAdded.push({ kind: i.kind, masked: maskIdentifier(i.kind, value) });
        journal.count("identifiers_added");
      }
    };
    const createEntity = async (name: string, type: PayeeType, extra: { note?: string | null; defaultCategoryId?: number | null; website?: string | null } = {}, allowedOwners?: ReadonlySet<number>) => {
      const clean = validateEntityName(name);
      assertExactFree(entities, clean, undefined, allowedOwners);
      const website = extra.website ? normalizeWebsite(extra.website) : null;
      const id = await insertEntity(btx, userId, dek, { name: clean, type, note: extra.note ?? null, defaultCategoryId: extra.defaultCategoryId ?? null, website });
      journal.createdEntity(id);
      await insertAlias(btx, userId, dek, { entityId: id, pattern: clean, mode: "exact", source: "canonical" });
      out.created = true;
      out.entity = { id, name: clean, type };
      journal.count("entities_created");
      return id;
    };

    const steps = root.op === "bulk" ? root.ops : [root];
    for (let step = 0; step < steps.length; step++) {
      const op = steps[step];
      // Each step sees the directory as the previous steps left it.
      entities.splice(0, entities.length, ...(await loadDirectory(btx, userId, dek)));
      try {
        switch (op.op) {
          case "create": {
            const id = await createEntity(op.name, asType(op.type, op.name), { note: op.note, defaultCategoryId: op.defaultCategoryId, website: op.website });
            await addAliases(id, op.aliases ?? [], src("manual"));
            await addIdentifiers(id, op.identifiers ?? []);
            if (guessPayeeType(op.name).isPerson && !["person", "sole_proprietor"].includes(out.entity!.type)) {
              out.warnings.push(`"${op.name}" looks like a private person; check the type.`);
            }
            if (op.apply !== false) applyTo.push(id);
            break;
          }
          case "update": {
            const e = entityOf(entities, op.entityId);
            await journal.willModify([e.id]);
            const patch: Parameters<typeof updateEntityRow>[4] = {};
            let renamed = false;
            if (op.name !== undefined) {
              const clean = validateEntityName(op.name);
              if (clean !== e.name) {
                assertExactFree(entities, clean, e.id);
                patch.name = clean;
                renamed = true;
              }
            }
            if (op.type !== undefined) patch.type = asType(op.type, e.name);
            if (op.note !== undefined) patch.note = op.note?.trim() ? op.note.trim() : null;
            if (op.defaultCategoryId !== undefined) {
              if (op.defaultCategoryId != null) {
                const cat = normalizeDbRows(await btx.execute(sql`SELECT id FROM categories WHERE id = ${op.defaultCategoryId} AND user_id = ${userId}`));
                if (!cat.length) throw new PayeeDirectoryError(`No category #${op.defaultCategoryId}.`, "not_found");
              }
              patch.defaultCategoryId = op.defaultCategoryId;
            }
            if (op.website !== undefined) {
              patch.website = op.website?.trim() ? normalizeWebsite(op.website) : null;
              if (patch.website === e.website) delete patch.website;
            }
            if (op.logo !== undefined) {
              patch.logo = op.logo?.trim() ? normalizeLogo(op.logo) : null;
              if (patch.logo === e.logo) delete patch.logo;
            }
            if ((patch.website || patch.logo) && PERSON_ENTITY_TYPES.has(patch.type ?? e.type)) {
              out.warnings.push(`“${e.name}” is a private person or sole proprietor; a website or logo is usually for merchants.`);
            }
            if (patch.website !== undefined) journal.count("website_set");
            if (patch.logo !== undefined) journal.count("logo_set");
            await updateEntityRow(btx, userId, dek, e.id, patch);
            if (renamed) {
              // The old canonical name stays as an alias, so rows already using it still resolve.
              await btx.execute(sql`UPDATE payee_aliases SET source = 'rename' WHERE entity_id = ${e.id} AND user_id = ${userId} AND source = 'canonical'`);
              await insertAlias(btx, userId, dek, { entityId: e.id, pattern: patch.name!, mode: "exact", source: "canonical" });
              journal.count("renamed");
              if (op.apply !== false) applyTo.push(e.id);
            }
            journal.count("updated");
            out.entity = { id: e.id, name: patch.name ?? e.name, type: patch.type ?? e.type };
            break;
          }
          case "alias_add": {
            const e = entityOf(entities, op.entityId);
            await journal.willModify([e.id]);
            if (!op.aliases.length) throw new PayeeDirectoryError("Name at least one alias.");
            await addAliases(e.id, op.aliases, src("manual"));
            out.entity = { id: e.id, name: e.name, type: e.type };
            if (op.apply !== false && out.aliasesAdded.length) applyTo.push(e.id);
            break;
          }
          case "alias_from_rule": {
            const rows = normalizeDbRows<{ id: unknown; conditions: unknown; actions: unknown }>(
              await btx.execute(sql`SELECT id, conditions, actions FROM transaction_rules WHERE id = ${op.ruleId} AND user_id = ${userId}`),
            );
            if (!rows.length) throw new PayeeDirectoryError(`No rule #${op.ruleId}.`, "not_found");
            const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
            const rule = decryptRuleFields(dek, { conditions: parse(rows[0].conditions), actions: parse(rows[0].actions) } as Parameters<typeof decryptRuleFields>[1]) as {
              conditions: { all?: Array<{ field?: string; op?: string; value?: unknown }> };
              actions: Array<{ kind?: string; to?: unknown }>;
            };
            const aliases: AliasInput[] = (rule.conditions?.all ?? [])
              .filter((c) => c.field === "payee" && typeof c.value === "string" && c.value)
              .map((c) => ({ pattern: String(c.value), mode: asMode(c.op === "exact" ? "exact" : c.op) }));
            if (!aliases.length) throw new PayeeDirectoryError("This rule has no payee condition to turn into an alias.");
            let entityId = op.entityId;
            if (entityId == null) {
              const to = rule.actions?.find((a) => a.kind === "rename_payee" && typeof a.to === "string")?.to as string | undefined;
              if (!to) throw new PayeeDirectoryError("Pick the payee entity: this rule doesn't rename the payee.");
              const owner = exactAliasOwners(entities, to)[0];
              entityId = owner ? owner.id : await createEntity(to, guessPayeeType(to).type);
            }
            const e = entities.find((x) => x.id === entityId);
            if (e) await journal.willModify([e.id]);
            else if (!out.created) entityOf(entities, entityId);
            await addAliases(entityId, aliases, "rule");
            out.entity = out.entity ?? (e ? { id: e.id, name: e.name, type: e.type } : null);
            if (op.apply !== false) applyTo.push(entityId);
            break;
          }
          case "alias_remove": {
            const e = entityOf(entities, op.entityId);
            const ids = new Set(op.aliasIds ?? []);
            for (const p of op.patterns ?? []) {
              const key = payeeMatchKey(p);
              for (const a of e.aliases) if (a.pattern === p.trim() || (a.mode === "exact" && key && payeeMatchKey(a.pattern) === key)) ids.add(a.id);
            }
            const victims = e.aliases.filter((a) => ids.has(a.id));
            if (!victims.length) throw new PayeeDirectoryError("None of those aliases belong to this payee.", "not_found");
            if (victims.some((a) => a.source === "canonical")) throw new PayeeDirectoryError("The canonical name can't be removed; rename the payee instead.");
            await journal.willModify([e.id]);
            await btx.execute(sql`DELETE FROM payee_aliases WHERE user_id = ${userId} AND entity_id = ${e.id} AND id IN (${sql.join(victims.map((a) => sql`${a.id}`), sql`, `)})`);
            out.aliasesRemoved = victims.length;
            journal.count("aliases_removed", victims.length);
            out.entity = { id: e.id, name: e.name, type: e.type };
            break;
          }
          case "identifiers": {
            const e = entityOf(entities, op.entityId);
            await journal.willModify([e.id]);
            await addIdentifiers(e.id, op.add ?? []);
            const remove = (op.remove ?? []).filter((id) => e.identifiers.some((i) => i.id === id));
            if (remove.length) {
              await btx.execute(sql`DELETE FROM payee_identifiers WHERE user_id = ${userId} AND entity_id = ${e.id} AND id IN (${sql.join(remove.map((i) => sql`${i}`), sql`, `)})`);
              out.identifiersRemoved = remove.length;
              journal.count("identifiers_removed", remove.length);
            }
            if (!out.identifiersAdded.length && !remove.length) throw new PayeeDirectoryError("Nothing to add or remove.");
            out.entity = { id: e.id, name: e.name, type: e.type };
            break;
          }
          case "merge": {
            const sourceIds = [...new Set(op.entityIds ?? [])];
            const sources = sourceIds.map((id) => entityOf(entities, id));
            const payees = [...new Set((op.payees ?? []).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean))];
            const target: PayeeEntity | null = "entityId" in op.into ? entityOf(entities, op.into.entityId) : null;
            // Aliases owned by the entities being merged may move freely.
            const allowed = new Set([...sourceIds, ...(target ? [target.id] : [])]);
            const merged = sources.filter((s) => s.id !== target?.id);
            if (!merged.length && !payees.length) throw new PayeeDirectoryError("Name the payees or entities to merge.");
            // Person / merchant mixing is allowed by hand, but said out loud.
            const names = [...merged.map((s) => s.name), ...payees, target?.name ?? ("name" in op.into ? op.into.name : "")];
            const people = names.filter((n) => n && guessPayeeType(n).isPerson);
            if (people.length && people.length < names.filter(Boolean).length) {
              out.warnings.push(`This mixes a private person (${people[0]}) with other payees. Check before confirming.`);
            }
            for (const p of payees) assertExactFree(entities, p, target?.id, allowed);
            let targetId: number;
            if (target) {
              await journal.willModify([target.id, ...merged.map((s) => s.id)]);
              targetId = target.id;
              out.entity = { id: target.id, name: target.name, type: target.type };
            } else {
              const into = op.into as { name: string; type?: PayeeType };
              await journal.willModify(merged.map((s) => s.id));
              const keep = merged[0];
              targetId = await createEntity(into.name, asType(into.type, into.name), { note: keep?.note ?? null, defaultCategoryId: keep?.defaultCategoryId ?? null }, allowed);
            }
            for (const s of merged) {
              // Move every alias; a merged entity's canonical name becomes an ordinary exact alias.
              await btx.execute(sql`
                UPDATE payee_aliases SET entity_id = ${targetId}, source = CASE WHEN source = 'canonical' THEN 'merge' ELSE source END
                WHERE user_id = ${userId} AND entity_id = ${s.id}`);
              await btx.execute(sql`UPDATE payee_identifiers SET entity_id = ${targetId} WHERE user_id = ${userId} AND entity_id = ${s.id}`);
              await btx.execute(sql`DELETE FROM payee_entities WHERE user_id = ${userId} AND id = ${s.id}`);
              out.entitiesRemoved++;
              journal.count("entities_merged");
            }
            // Duplicate exact aliases / identifiers left by the move collapse to one.
            await dedupeEntity(btx, userId, dek, targetId);
            const reloaded = await loadDirectory(btx, userId, dek);
            entities.splice(0, entities.length, ...reloaded);
            await addAliases(targetId, payees.map((p) => ({ pattern: p, mode: "exact" as const })), src("merge"));
            if (op.apply !== false) applyTo.push(targetId);
            break;
          }
          case "split": {
            const e = entityOf(entities, op.entityId);
            const moving = e.aliases.filter((a) => op.aliasIds.includes(a.id));
            if (!moving.length) throw new PayeeDirectoryError("Pick the aliases to split off.", "not_found");
            if (moving.some((a) => a.source === "canonical")) throw new PayeeDirectoryError("The canonical name stays with the payee; pick other aliases.");
            await journal.willModify([e.id]);
            const id = await createEntity(op.name, asType(op.type, op.name), {}, new Set([e.id]));
            await btx.execute(sql`
              UPDATE payee_aliases SET entity_id = ${id}, source = 'split'
              WHERE user_id = ${userId} AND entity_id = ${e.id} AND id IN (${sql.join(moving.map((a) => sql`${a.id}`), sql`, `)})`);
            journal.count("aliases_moved", moving.length);
            await dedupeEntity(btx, userId, dek, id);
            out.warnings.push(`Rows already renamed to "${e.name}" keep that name; undo the batch that renamed them to get the original spellings back.`);
            if (op.apply !== false) applyTo.push(id);
            break;
          }
          case "apply": {
            const ids = op.entityIds?.length ? op.entityIds : entities.map((e) => e.id);
            for (const id of ids) entityOf(entities, id);
            applyTo.push(...ids);
            break;
          }
          case "move_remainder": {
            const e = entityOf(entities, op.entityId);
            const keys = new Set(op.payees.map((p) => payeeMatchKey(p)).filter(Boolean));
            if (!keys.size) throw new PayeeDirectoryError("Name the spelling(s) to rename.");
            const target = op.target === "note" ? "note" : "tag";
            // A tag can't hold the tag separator; a note can hold anything.
            const remainder = (target === "tag" ? op.remainder.replace(/,/g, " ") : op.remainder).replace(/\s+/g, " ").trim();
            if (!remainder) throw new PayeeDirectoryError("The text to keep can't be empty.");
            if (remainder.length > 200) throw new PayeeDirectoryError("The text to keep is too long (200 characters max).");
            await journal.willModify([e.id]);
            const planned: Array<{ id: string; payee: string | null; tags: string | null; note: string | null; plain: string }> = [];
            let after = 0;
            for (;;) {
              const page = normalizeDbRows<Record<string, unknown>>(
                await btx.execute(sql`SELECT id, payee, tags, note FROM transactions WHERE user_id = ${userId} AND id > ${after} ORDER BY id LIMIT 2000`),
              );
              for (const r of page) {
                after = Number(r.id);
                const plain = decodeStoredPayee(r.payee, null, dek);
                if (plain === undefined || !keys.has(payeeMatchKey(plain))) continue;
                planned.push({ id: String(r.id), payee: r.payee == null ? null : String(r.payee), tags: r.tags == null ? null : String(r.tags), note: r.note == null ? null : String(r.note), plain: spellingOf(plain) });
              }
              if (page.length < 2000) break;
            }
            if (planned.length > PAYEE_APPLY_MAX_ROWS) {
              out.blocked = `This would change ${planned.length.toLocaleString("en-US")} rows; one change can cover at most ${PAYEE_APPLY_MAX_ROWS.toLocaleString("en-US")}.`;
              break;
            }
            const payeeWrites: Array<{ id: string; value: string | null }> = [];
            const colWrites: Array<{ id: string; value: string | null }> = [];
            const changes = new Map<string, number>();
            for (const r of planned) {
              const newPayee = encryptField(dek, e.name);
              let colOld: string | null;
              let colNew: string | null;
              if (target === "tag") {
                const cur = decodeStoredPayee(r.tags, null, dek) ?? "";
                const next = addTags(cur, remainder);
                colOld = r.tags;
                colNew = next === cur ? r.tags : encryptField(dek, next);
              } else {
                const cur = decodeStoredPayee(r.note, null, dek) ?? "";
                const next = cur.includes(remainder) ? cur : cur.trim() ? `${cur.trim()}; ${remainder}` : remainder;
                colOld = r.note;
                colNew = next === cur ? r.note : encryptField(dek, next);
              }
              payeeWrites.push({ id: r.id, value: newPayee });
              if (colNew !== colOld) colWrites.push({ id: r.id, value: colNew });
              journal.rowChanged({ t: "transactions", id: r.id, old: r.payee, new: newPayee, ...(colNew !== colOld ? { cols: { [target === "tag" ? "tags" : "note"]: { old: colOld, new: colNew } } } : {}) });
              changes.set(r.plain, (changes.get(r.plain) ?? 0) + 1);
            }
            await writeStoredPayees(btx, userId, "transactions", payeeWrites);
            await writeTransactionColumn(btx, userId, target === "tag" ? "tags" : "note", colWrites);
            journal.count("transactions", payeeWrites.length);
            journal.count(target === "tag" ? "tags_added" : "notes_extended", colWrites.length);
            out.rows = {
              total: payeeWrites.length,
              byTable: { transactions: payeeWrites.length, recurring: 0, staged: 0 },
              changes: [...changes.entries()].map(([from, count]) => ({ from, to: e.name, entityId: e.id, count })).sort((a, b) => b.count - a.count),
              conflicts: [],
              truncated: false,
            };
            out.fingerprint = createHash("sha256").update(`move_remainder:${e.id}:${target}:${remainder}:${planned.map((p) => p.id).join(",")}`).digest("hex").slice(0, 32);
            out.entity = { id: e.id, name: e.name, type: e.type };
            if (!payeeWrites.length) out.warnings.push("No transactions carry that spelling any more.");
            break;
          }
          case "delete": {
            const e = entityOf(entities, op.entityId);
            await journal.willModify([e.id]);
            await btx.execute(sql`DELETE FROM payee_entities WHERE user_id = ${userId} AND id = ${e.id}`);
            out.entitiesRemoved = 1;
            journal.count("entities_deleted");
            out.entity = { id: e.id, name: e.name, type: e.type };
            break;
          }
        }
      } catch (e) {
        // In a bulk batch, say which step failed (the whole batch rolls back).
        const label = root.op === "bulk" ? root.labels?.[step] : undefined;
        if (label && e instanceof PayeeDirectoryError) throw new PayeeDirectoryError(`${label}: ${e.message}`, e.code);
        throw e;
      }
    }

    if (applyTo.length) {
      const dir = await loadDirectory(btx, userId, dek);
      const matcher = buildPayeeMatcher(dir);
      const plan = await planPayeeApply({ executor: btx, userId, dek, matcher, entityIds: new Set(applyTo) });
      out.rows = { total: plan.total, byTable: plan.byTable, changes: plan.changes.slice(0, 50), conflicts: plan.conflicts.slice(0, 50), truncated: plan.truncated };
      out.fingerprint = planFingerprint({ rows: plan.rows.map((r) => ({ ...r, entityId: 0 })) });
      if (plan.tooLarge) out.blocked = `This would rename ${plan.total.toLocaleString("en-US")} rows; one change can cover at most ${PAYEE_APPLY_MAX_ROWS.toLocaleString("en-US")}. Apply fewer payees at a time.`;
      else if (plan.truncated) out.blocked = "The payee scan stopped early (very large ledger); apply fewer payees at a time.";
      if (plan.conflicts.length) out.warnings.push(`${plan.conflicts.length} spelling(s) match more than one payee and are left alone.`);
      if (!out.blocked) await runPayeeApply({ tx: btx, journal, userId, dek, matcher, plan });
      if (out.entity) {
        const fresh = dir.find((d) => d.id === out.entity!.id);
        if (fresh) out.entity = { id: fresh.id, name: fresh.name, type: fresh.type };
      }
    }
    if (!out.fingerprint) out.fingerprint = `${root.op}:${out.entity?.id ?? ""}:${out.aliasesAdded.length}:${out.aliasesRemoved}:${out.identifiersAdded.length}:${out.identifiersRemoved}:${out.entitiesRemoved}`;
  });
  out.batchId = batchId;
  return out;
}

/** Collapse duplicate exact aliases (same key) and identifiers on one entity. */
async function dedupeEntity(tx: PayeeExecutor, userId: string, dek: Buffer, entityId: number): Promise<void> {
  const dir = await loadDirectory(tx, userId, dek);
  const e = dir.find((x) => x.id === entityId);
  if (!e) return;
  const seen = new Set<string>();
  const dropAliases: number[] = [];
  // Canonical first so it is the one kept.
  for (const a of [...e.aliases].sort((x, y) => Number(y.source === "canonical") - Number(x.source === "canonical"))) {
    const k = a.mode === "exact" ? `e:${payeeMatchKey(a.pattern)}` : `${a.mode}:${a.pattern}`;
    if (seen.has(k)) dropAliases.push(a.id);
    else seen.add(k);
  }
  const seenId = new Set<string>();
  const dropIds: number[] = [];
  for (const i of e.identifiers) {
    const k = `${i.kind}:${i.value}`;
    if (seenId.has(k)) dropIds.push(i.id);
    else seenId.add(k);
  }
  if (dropAliases.length) await tx.execute(sql`DELETE FROM payee_aliases WHERE user_id = ${userId} AND id IN (${sql.join(dropAliases.map((i) => sql`${i}`), sql`, `)})`);
  if (dropIds.length) await tx.execute(sql`DELETE FROM payee_identifiers WHERE user_id = ${userId} AND id IN (${sql.join(dropIds.map((i) => sql`${i}`), sql`, `)})`);
}

export { PayeeDirectoryError, PayeeBatchError };
