/**
 * manage_payees — Payee Studio over MCP.
 *
 * Payees are per-row encrypted free text in transactions, recurring, staged,
 * SimpleFIN pending and the bank ledger, so every op reads and decrypts them
 * (src/lib/payees — the same code Settings → Payees uses) and works in
 * memory. The server never calls an LLM: the AI client looks at the compact
 * structured answers and proposes; the human approves.
 *
 * Read ops: list, clusters, get, batches, insights, review, proposals,
 * explain (P5a: why two payees are / aren't clustered).
 * Write ops (directory + payee rewrite, each ONE undoable batch): create,
 * update, alias_add, alias_remove, identifiers, merge, split, apply, undo.
 * Every write is TWO-STEP: without `confirmation_token` it runs as a dry run
 * (rolled-back transaction) and returns exactly what would change plus a
 * token bound to those rows; the same call with the token commits. The AI
 * proposes, the human approves.
 *
 * AI layer (P3): review returns a compact pack (unrecognized payees and
 * clusters with example rows, plus the directory); propose stores drafts and
 * changes NOTHING; approve (two-step) applies chosen drafts as one batch;
 * reject drops drafts; proposals lists them.
 *
 * Identifiers (IBAN, tax id, card) are masked in every answer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type PgToolContext, dataResponse, err } from "./_shared";
import { registerManageTool } from "./_consolidate";
import { signPreviewToken, verifyPreviewToken } from "./_confirm";
import { executePayeeOp, PayeeBatchError, PayeeDirectoryError, type PayeeOp, type PayeeOpResult } from "../../src/lib/payees/ops";
import { listPayeeBatches } from "../../src/lib/payees/batches";
import { planPayeeApply } from "../../src/lib/payees/apply";
import { ALIAS_MODES, IDENTIFIER_KINDS, maskIdentifier, type PayeeEntity } from "../../src/lib/payees/directory";
import { PAYEE_TYPES } from "../../src/lib/payees/match-key";
import {
  approveProposals,
  buildReviewPack,
  listProposals,
  MAX_PROPOSALS_PER_CALL,
  proposalOut,
  rejectProposals,
  saveProposals,
} from "../../src/lib/payees/proposals";
import { computePayeeInsights } from "../../src/lib/payees/insights";
import { explainPayeePair } from "../../src/lib/payees/explain";
import { makeSliceConverter } from "../../src/lib/payees/service";
import { buildPayeeMatcher, loadDirectory } from "../../src/lib/payees/directory";
import { containsNormalized } from "../../src/lib/text-normalize";
import { payeeMatchKey } from "../../src/lib/payees/match-key";
import { loadLookalikes, loadMerchantAnalytics, loadPayeeOverview, type PayeeOverview } from "../../src/lib/payees/service";
import { cancelRejection, rejectLookalike } from "../../src/lib/payees/lookalikes";
import { unrecognizedGroups, type PayeeCluster, type PayeeGroup } from "../../src/lib/payees/overview";

const ymdArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const NO_DEK_NOTE = "No decryption key on this connection: encrypted payees can't be read, only legacy plaintext ones are shown.";

/** Compact group shape for an LLM: names and numbers, no ids it can't use. */
function groupOut(g: PayeeGroup, detail = false) {
  return {
    name: g.name,
    key: g.key,
    count: g.count,
    total: g.total,
    firstDate: g.firstDate,
    lastDate: g.lastDate,
    spellings: detail ? g.spellings : g.spellings.slice(0, 5),
    ...(g.spellings.length > 5 && !detail ? { moreSpellings: g.spellings.length - 5 } : {}),
    categories: (detail ? g.categories : g.categories.slice(0, 3)).map((c) => (detail ? c : c.name)),
    accounts: (detail ? g.accounts : g.accounts.slice(0, 3)).map((a) => (detail ? a : a.name)),
    typeGuess: g.type.type,
    ...(g.type.isPerson ? { person: true } : {}),
    ...(g.noisy ? { noisy: true } : {}),
    ...(detail ? { suggestedName: g.suggestedName, sources: g.sources, typeReason: g.type.reason } : {}),
    entity: g.entityId == null ? null : { id: g.entityId, name: g.entityName },
  };
}

function clusterOut(c: PayeeCluster) {
  return {
    cluster_id: c.id,
    confidence: c.confidence,
    reasons: c.reasons,
    needsDecision: c.needsDecision,
    ...(c.decisionReason ? { decisionReason: c.decisionReason } : {}),
    suggestedName: c.suggestedName,
    suggestedType: c.suggestedType.type,
    count: c.count,
    total: c.total,
    members: c.groups.map((g) => ({
      name: g.name,
      key: g.key,
      count: g.count,
      spellings: g.spellings.slice(0, 6),
      entity: g.entityId == null ? null : { id: g.entityId, name: g.entityName },
    })),
  };
}

function entityOut(e: PayeeEntity) {
  return {
    entity_id: e.id,
    name: e.name,
    type: e.type,
    ...(e.website ? { website: e.website } : {}),
    has_logo: e.logo != null,
    ...(e.note ? { note: e.note } : {}),
    default_category_id: e.defaultCategoryId,
    aliases: e.aliases.map((a) => ({ alias_id: a.id, pattern: a.pattern, mode: a.mode, source: a.source })),
    identifiers: e.identifiers.map((i) => ({ identifier_id: i.id, kind: i.kind, value: maskIdentifier(i.kind, i.value) })),
  };
}

/** What a preview / commit tells the AI client: counts, spellings, warnings. */
function opOut(r: PayeeOpResult) {
  return {
    op: r.op,
    ...(r.batchId != null && !r.dryRun ? { batch_id: r.batchId } : {}),
    entity: r.entity ? { entity_id: r.entity.id, name: r.entity.name, type: r.entity.type } : null,
    ...(r.created ? { created: true } : {}),
    ...(r.aliasesAdded.length ? { aliasesAdded: r.aliasesAdded } : {}),
    ...(r.aliasesRemoved ? { aliasesRemoved: r.aliasesRemoved } : {}),
    ...(r.identifiersAdded.length ? { identifiersAdded: r.identifiersAdded } : {}),
    ...(r.identifiersRemoved ? { identifiersRemoved: r.identifiersRemoved } : {}),
    ...(r.entitiesRemoved ? { entitiesRemoved: r.entitiesRemoved } : {}),
    rows: {
      total: r.rows.total,
      byTable: r.rows.byTable,
      changes: r.rows.changes.slice(0, 20).map((c) => ({ from: c.from, to: c.to, count: c.count })),
      ...(r.rows.conflicts.length ? { conflicts: r.rows.conflicts.slice(0, 20) } : {}),
    },
    ...(r.undo ? { undo: r.undo } : {}),
    ...(r.warnings.length ? { warnings: r.warnings } : {}),
    ...(r.blocked ? { blocked: r.blocked } : {}),
  };
}

export function registerPayeesTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;

  const overview = (): Promise<PayeeOverview> => loadPayeeOverview({ executor: db, userId, dek });

  function scanMeta(o: PayeeOverview) {
    const notes: string[] = [];
    if (!dek) notes.push(NO_DEK_NOTE);
    if (o.truncated.length) notes.push(`Scan stopped early in: ${o.truncated.join(", ")}.`);
    if (o.undecryptable) notes.push(`${o.undecryptable} payee value(s) could not be decrypted and were skipped.`);
    return { currency: o.currency, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }

  async function opList(input: { view?: "all" | "unrecognized" | "entities"; search?: string; sort?: "count" | "total" | "name" | "last_date"; limit?: number }) {
    const o = await overview();
    if (input.view === "entities") {
      let ents = o.entities;
      if (input.search?.trim()) {
        const needle = input.search;
        const ids = new Set(o.directory.filter((e) => e.aliases.some((a) => containsNormalized(a.pattern, needle)) || containsNormalized(e.name, needle)).map((e) => e.id));
        ents = ents.filter((e) => ids.has(e.id));
      }
      if (input.sort === "name") ents = [...ents].sort((a, b) => a.name.localeCompare(b.name));
      else if (input.sort === "total") ents = [...ents].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      const limit = input.limit ?? 100;
      return dataResponse({
        entities: ents.slice(0, limit).map((e) => ({ entity_id: e.id, name: e.name, type: e.type, count: e.count, total: e.total, lastDate: e.lastDate, aliases: e.aliasCount, identifiers: e.identifierCount })),
        total: ents.length,
        ...scanMeta(o),
      });
    }
    let groups = input.view === "unrecognized" ? unrecognizedGroups(o.groups) : o.groups.filter((g) => g.key);
    if (input.search?.trim()) {
      const needle = input.search;
      groups = groups.filter((g) => g.spellings.some((s) => containsNormalized(s.spelling, needle)) || (g.entityName != null && containsNormalized(g.entityName, needle)));
    }
    const sort = input.sort ?? "count";
    if (sort === "total") groups = [...groups].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    else if (sort === "name") groups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "last_date") groups = [...groups].sort((a, b) => (b.lastDate ?? "").localeCompare(a.lastDate ?? ""));
    const limit = input.limit ?? 100;
    const emptyPayee = o.groups.find((g) => !g.key);
    return dataResponse({
      payees: groups.slice(0, limit).map((g) => groupOut(g)),
      total: groups.length,
      ...(groups.length > limit ? { more: `Showing ${limit} of ${groups.length}; raise \`limit\` or pass \`search\`.` } : {}),
      ...(emptyPayee ? { blankPayeeTransactions: emptyPayee.count } : {}),
      ...scanMeta(o),
    });
  }

  async function opClusters(input: { min_confidence?: number; include_needs_decision?: boolean; limit?: number }) {
    const o = await overview();
    const min = input.min_confidence ?? 0;
    let clusters = o.clusters.filter((c) => c.confidence >= min);
    if (input.include_needs_decision === false) clusters = clusters.filter((c) => !c.needsDecision);
    const limit = input.limit ?? 50;
    return dataResponse({
      clusters: clusters.slice(0, limit).map(clusterOut),
      total: clusters.length,
      needsDecision: clusters.filter((c) => c.needsDecision).length,
      ...scanMeta(o),
    });
  }

  async function opGet(input: { payee?: string; key?: string; cluster_id?: string; entity_id?: number }) {
    const o = await overview();
    if (input.cluster_id) {
      const c = o.clusters.find((x) => x.id === input.cluster_id);
      if (!c) return err(`No cluster "${input.cluster_id}". Cluster ids change when payees change; re-run op=clusters.`);
      return dataResponse({ cluster: clusterOut(c), groups: c.groups.map((g) => groupOut(g, true)), ...scanMeta(o) });
    }
    const key = input.key ?? (input.payee != null ? payeeMatchKey(input.payee) : null);
    if (key == null) return err("Pass `payee` (any spelling), `key` or `cluster_id`.");
    const g = o.groups.find((x) => x.key === key);
    if (!g) return err(`No payee matches "${input.payee ?? input.key}". Try op=list with search.`);
    const cluster = o.clusters.find((c) => c.keys.includes(key));
    return dataResponse({ payee: groupOut(g, true), ...(cluster ? { cluster: clusterOut(cluster) } : {}), ...scanMeta(o) });
  }

  /** Dry run → token; same call + token → commit. */
  async function writeOp(op: PayeeOp, token: string | undefined) {
    if (!dek) return err("Unlock required: payee changes need the encryption key. Sign in to Finlynq in the browser, then retry.");
    try {
      const preview = await executePayeeOp({ executor: db, userId, dek, op, actor: "mcp", dryRun: true });
      const payload = { op, fingerprint: preview.fingerprint };
      const operation = `manage_payees_${op.op}`;
      if (!token) {
        if (preview.blocked) return dataResponse({ preview: true, ...opOut(preview), note: "Blocked: no confirmation token issued." });
        return dataResponse({ preview: true, ...opOut(preview), confirmationToken: signPreviewToken(userId, operation, payload) });
      }
      if (preview.blocked) return err(`Refusing to execute: ${preview.blocked}`);
      const check = verifyPreviewToken(token, userId, operation, payload);
      if (!check.valid) {
        return err(
          check.reason === "no_token"
            ? "no_token: call without confirmation_token first to preview."
            : `Confirmation token invalid: ${check.reason}. The data may have changed; re-call without confirmation_token to refresh the preview.`,
        );
      }
      const done = await executePayeeOp({ executor: db, userId, dek, op, actor: "mcp" });
      return dataResponse({ ...opOut(done), changed: done.rows.total, ...(done.batchId != null && op.op !== "undo" ? { undoWith: `manage_payees op=undo batch_id=${done.batchId} (within 30 days)` } : {}) });
    } catch (e) {
      if (e instanceof PayeeDirectoryError || e instanceof PayeeBatchError) return err(e.message);
      throw e;
    }
  }

  async function opEntity(entityId: number) {
    const o = await overview();
    const e = o.directory.find((x) => x.id === entityId);
    if (!e) return err(`No payee entity #${entityId}. Use op=list view=entities.`);
    const pending = await planPayeeApply({ executor: db, userId, dek, matcher: o.matcher, entityIds: new Set([entityId]) });
    const history = await listPayeeBatches(db, userId, { entityId, limit: 20 });
    return dataResponse({
      entity: entityOut(e),
      spellings: o.groups.filter((g) => g.entityId === entityId).map((g) => groupOut(g)),
      pendingApply: { total: pending.total, byTable: pending.byTable, changes: pending.changes.slice(0, 20).map((c) => ({ from: c.from, count: c.count })) },
      history: history.map((b) => ({ batch_id: b.id, kind: b.kind, actor: b.actor, summary: b.summary, createdAt: b.createdAt, undone: b.undoneAt != null, canUndo: b.canUndo })),
      ...scanMeta(o),
    });
  }

  async function clusterPayees(ids: string[]): Promise<string[] | string> {
    const o = await overview();
    const out: string[] = [];
    for (const id of ids) {
      const c = o.clusters.find((x) => x.id === id);
      if (!c) return `No cluster "${id}". Cluster ids change when payees change; re-run op=clusters.`;
      for (const g of c.groups) for (const sp of g.spellings) out.push(sp.spelling);
    }
    return out;
  }

  async function opApprove(ids: number[], token: string | undefined) {
    if (!dek) return err("Unlock required: payee changes need the encryption key. Sign in to Finlynq in the browser, then retry.");
    try {
      const sorted = [...new Set(ids)].sort((a, b) => a - b);
      const preview = await approveProposals({ executor: db, userId, dek, ids: sorted, actor: "mcp", dryRun: true });
      const payload = { ids: sorted, fingerprint: preview.result.fingerprint };
      if (!token) {
        if (preview.result.blocked) return dataResponse({ preview: true, ...opOut(preview.result), note: "Blocked: no confirmation token issued." });
        return dataResponse({ preview: true, proposals: sorted, ...opOut(preview.result), confirmationToken: signPreviewToken(userId, "manage_payees_approve", payload) });
      }
      const check = verifyPreviewToken(token, userId, "manage_payees_approve", payload);
      if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-call without confirmation_token to refresh the preview.`);
      const done = await approveProposals({ executor: db, userId, dek, ids: sorted, actor: "mcp" });
      return dataResponse({ approved: done.approved, ...opOut(done.result), changed: done.result.rows.total, ...(done.result.batchId != null ? { undoWith: `manage_payees op=undo batch_id=${done.result.batchId} (within 30 days)` } : {}) });
    } catch (e) {
      if (e instanceof PayeeDirectoryError || e instanceof PayeeBatchError) return err(e.message);
      throw e;
    }
  }

  const tokenArg = z
    .string()
    .optional()
    .describe("Token from the preview call with the same arguments. Omit to preview; pass verbatim to commit. Single-use; 5-minute TTL.");
  const typeArg = z.enum(PAYEE_TYPES).optional().describe("retail | service | bank | government | person | sole_proprietor | company | other. Omit to guess from the name.");
  const aliasArg = z
    .array(z.union([z.string(), z.object({ pattern: z.string(), mode: z.enum(ALIAS_MODES).optional() })]))
    .optional()
    .describe("Spellings that resolve to the payee: a string (exact match — case, apostrophes, Latin/Cyrillic and terminal noise ignored) or {pattern, mode: exact|contains|regex}.");
  const identifierArg = z
    .array(z.object({ kind: z.enum(IDENTIFIER_KINDS), value: z.string() }))
    .optional()
    .describe("Requisites: iban | tax_id | edrpou | card_last4 (a full card number is cut to its last 4 digits) | crypto_wallet.");
  const applyArg = z.boolean().optional().describe("Also rename stored payees to the canonical name (default true).");
  const toAliases = (a: Array<string | { pattern: string; mode?: (typeof ALIAS_MODES)[number] }> | undefined) =>
    (a ?? []).map((x) => (typeof x === "string" ? { pattern: x } : x));

  registerManageTool(
    server,
    "manage_payees",
    "Review and clean up payees (merchants, people, services). Reads: list, clusters, get, batches, insights, review, proposals, explain, lookalikes. AI workflow: review → propose (drafts, changes nothing) → the user approves (approve) or rejects. Writes: create, update, set_profile, alias_add, alias_remove, identifiers, merge, split, apply, move_remainder, reject_lookalike, undo. Every write and approve is TWO-STEP: call without confirmation_token to preview (rows per table + token), then repeat with the token; each commit is one batch, undoable for 30 days. Never merge a person with a merchant unless the user says so. Bank-statement rows and import hashes never change. Details per op: finlynq_help topic=payees.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("list"),
        view: z.enum(["all", "unrecognized", "entities"]).optional().describe("all (default), unrecognized = payees not linked to a directory entity, entities = the directory itself."),
        search: z.string().optional().describe("Only payees with a spelling containing this text."),
        sort: z.enum(["count", "total", "name", "last_date"]).optional().describe("Order: count (default), total (by absolute amount), name, last_date."),
        limit: z.number().int().positive().max(5000).optional().describe("Most payees to return (default 100)."),
      }),
      z.object({
        op: z.literal("clusters"),
        min_confidence: z.number().min(0).max(1).optional().describe("Only clusters at or above this confidence (0–1)."),
        include_needs_decision: z.boolean().optional().describe("false hides clusters containing a private person / sole proprietor (default true)."),
        limit: z.number().int().positive().max(1000).optional().describe("Most clusters to return (default 50)."),
      }),
      z.object({
        op: z.literal("get"),
        payee: z.string().optional().describe("Any spelling of the payee, e.g. \"EPITCENTR K10 KYIV 360616\"."),
        key: z.string().optional().describe("A payee `key` from list / clusters."),
        cluster_id: z.string().optional().describe("A `cluster_id` from clusters."),
        entity_id: z.number().int().positive().optional().describe("A directory entity: aliases, masked identifiers, spellings, pending renames, change history."),
      }),
      z.object({
        op: z.literal("batches"),
        entity_id: z.number().int().positive().optional().describe("Only batches that touched this entity."),
        limit: z.number().int().positive().max(200).optional().describe("Most batches (default 20), newest first."),
      }),
      z.object({
        op: z.literal("create"),
        name: z.string().describe("Canonical name, e.g. \"Епіцентр\"."),
        type: typeArg,
        note: z.string().optional(),
        default_category_id: z.number().int().positive().optional().describe("Category hint for this payee (not applied to transactions)."),
        aliases: aliasArg,
        identifiers: identifierArg,
        apply: applyArg,
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("update"),
        entity_id: z.number().int().positive(),
        name: z.string().optional().describe("New canonical name; the old one stays as an alias."),
        type: typeArg,
        note: z.string().nullable().optional(),
        default_category_id: z.number().int().positive().nullable().optional(),
        apply: applyArg,
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("alias_add"),
        entity_id: z.number().int().positive().optional().describe("The entity. Optional with rule_id when the rule renames the payee (the target is found or created)."),
        aliases: aliasArg,
        rule_id: z.number().int().positive().optional().describe("Turn this rule's payee conditions into aliases."),
        apply: applyArg,
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("alias_remove"),
        entity_id: z.number().int().positive(),
        alias_ids: z.array(z.number().int().positive()).optional(),
        patterns: z.array(z.string()).optional(),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("identifiers"),
        entity_id: z.number().int().positive(),
        add: identifierArg,
        remove: z.array(z.number().int().positive()).optional().describe("identifier_id values to remove."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("merge"),
        into_entity_id: z.number().int().positive().optional().describe("Merge into this existing entity…"),
        into_name: z.string().optional().describe("…or into a new entity with this canonical name."),
        into_type: typeArg,
        entity_ids: z.array(z.number().int().positive()).optional().describe("Entities folded into the target (deleted; their aliases and identifiers move)."),
        payees: z.array(z.string()).optional().describe("Spellings added as exact aliases of the target."),
        cluster_ids: z.array(z.string()).optional().describe("Every spelling of these clusters becomes an alias of the target."),
        apply: applyArg,
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("split"),
        entity_id: z.number().int().positive(),
        alias_ids: z.array(z.number().int().positive()).min(1).describe("Aliases moved to the new entity."),
        name: z.string().describe("Canonical name of the new entity."),
        type: typeArg,
        apply: applyArg,
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("apply"),
        entity_ids: z.array(z.number().int().positive()).optional().describe("Only these entities (default: the whole directory)."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("insights"),
        months: z.number().int().min(1).max(60).optional().describe("Window for top lists and monthly series (default 12)."),
        recent_days: z.number().int().min(7).max(730).optional().describe("\"New\" = first seen within this many days (default 90)."),
        limit: z.number().int().min(1).max(50).optional().describe("Rows per list (default 10)."),
        merchants: z.boolean().optional().describe("Add the 8 merchant analyses (receipt stats, receipt trend, count vs receipt change, new/quiet/returned/churned, regular payments, several categories, business+personal, people paid/received). On automatically with period / entity_id / name."),
        period_from: ymdArg.optional().describe("Merchant analyses: from this date."),
        period_to: ymdArg.optional().describe("Merchant analyses: up to this date."),
        entity_id: z.number().int().positive().optional().describe("Merchant analyses for this directory entry only."),
        name: z.string().optional().describe("Merchant analyses for this payee (any spelling) only."),
      }),
      z.object({
        op: z.literal("explain"),
        a: z.string().min(1).describe("First payee (any spelling)."),
        b: z.string().min(1).describe("Second payee."),
      }),
      z.object({
        op: z.literal("set_profile"),
        entity_id: z.number().int().positive(),
        website: z.string().nullable().optional().describe("http(s) address, stored as https://host/path; null clears. Skip people / sole proprietors."),
        logo: z.string().nullable().optional().describe("data:image/png|jpeg|webp;base64,… ≤ 20 KB (no SVG); null clears."),
        type: typeArg,
        note: z.string().nullable().optional(),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("lookalikes"),
        limit: z.number().int().positive().max(1000).optional().describe("Most suggestions (default 50)."),
      }),
      z.object({
        op: z.literal("move_remainder"),
        entity_id: z.number().int().positive().describe("The directory entry the spelling belongs to."),
        payees: z.array(z.string().min(1)).min(1).max(100).describe("The spelling(s), e.g. \"Степаненко компенсація житла\"."),
        remainder: z.string().min(1).max(200).describe("The text to keep, e.g. \"компенсація житла\" (from lookalikes `remainder`)."),
        target: z.enum(["tag", "note"]).optional().describe("tag (default) or note."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("reject_lookalike"),
        payee: z.string().min(1).describe("The spelling the user says is a DIFFERENT payee."),
        entity_id: z.number().int().positive(),
        undo: z.boolean().optional().describe("true cancels an earlier answer."),
      }),
      z.object({
        op: z.literal("review"),
        limit: z.number().int().positive().max(300).optional().describe("Most unrecognized payees in the pack (default 60; clusters get half)."),
      }),
      z.object({
        op: z.literal("propose"),
        proposals: z
          .array(
            z.object({
              canonical: z.string().describe("Canonical name, e.g. \"Епіцентр\"."),
              type: z.enum(PAYEE_TYPES).optional(),
              entity_id: z.number().int().positive().optional().describe("Extend this existing entry instead of creating one."),
              aliases: z.array(z.union([z.string(), z.object({ pattern: z.string(), mode: z.enum(ALIAS_MODES).optional() })])).optional().describe("Exact spellings from review (or {pattern, mode})."),
              identifiers: z.array(z.object({ kind: z.enum(IDENTIFIER_KINDS), value: z.string() })).optional(),
              website: z.string().optional().describe("The merchant's website if you found it (web search). Not for people / sole proprietors."),
              reason: z.string().optional().describe("Why, in one sentence the user will read."),
              confidence: z.number().min(0).max(1).optional().describe("0–1."),
            }),
          )
          .min(1)
          .max(MAX_PROPOSALS_PER_CALL),
      }),
      z.object({
        op: z.literal("proposals"),
        status: z.enum(["draft", "approved", "rejected", "all"]).optional().describe("Default draft."),
        limit: z.number().int().positive().max(1000).optional(),
      }),
      z.object({
        op: z.literal("approve"),
        proposal_ids: z.array(z.number().int().positive()).min(1).max(MAX_PROPOSALS_PER_CALL),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("reject"),
        proposal_ids: z.array(z.number().int().positive()).min(1).max(1000),
      }),
      z.object({
        op: z.literal("undo"),
        batch_id: z.number().int().positive().describe("A batch_id from a write result or op=batches."),
        confirmation_token: tokenArg,
      }),
    ]),
    async (input) => {
      try {
        switch (input.op) {
          case "list":
            return await opList(input);
          case "clusters":
            return await opClusters(input);
          case "get":
            return input.entity_id != null ? await opEntity(input.entity_id) : await opGet(input);
          case "batches": {
            const b = await listPayeeBatches(db, userId, { entityId: input.entity_id, limit: input.limit ?? 20 });
            return dataResponse({
              batches: b.map((x) => ({ batch_id: x.id, kind: x.kind, actor: x.actor, summary: x.summary, entity_ids: x.entityIds, createdAt: x.createdAt, undone: x.undoneAt != null, canUndo: x.canUndo })),
            });
          }
          case "create":
            return await writeOp(
              { op: "create", name: input.name, type: input.type, note: input.note, defaultCategoryId: input.default_category_id, aliases: toAliases(input.aliases), identifiers: input.identifiers, apply: input.apply },
              input.confirmation_token,
            );
          case "update":
            return await writeOp(
              { op: "update", entityId: input.entity_id, name: input.name, type: input.type, note: input.note, defaultCategoryId: input.default_category_id, apply: input.apply },
              input.confirmation_token,
            );
          case "alias_add":
            if (input.rule_id != null) {
              return await writeOp({ op: "alias_from_rule", ruleId: input.rule_id, entityId: input.entity_id, apply: input.apply }, input.confirmation_token);
            }
            if (input.entity_id == null) return err("Pass entity_id (or rule_id).");
            return await writeOp({ op: "alias_add", entityId: input.entity_id, aliases: toAliases(input.aliases), apply: input.apply }, input.confirmation_token);
          case "alias_remove":
            return await writeOp({ op: "alias_remove", entityId: input.entity_id, aliasIds: input.alias_ids, patterns: input.patterns }, input.confirmation_token);
          case "identifiers":
            if (!input.add?.length && !input.remove?.length) return await opEntity(input.entity_id);
            return await writeOp({ op: "identifiers", entityId: input.entity_id, add: input.add, remove: input.remove }, input.confirmation_token);
          case "merge": {
            let payees = input.payees ?? [];
            if (input.cluster_ids?.length) {
              const fromClusters = await clusterPayees(input.cluster_ids);
              if (typeof fromClusters === "string") return err(fromClusters);
              payees = [...payees, ...fromClusters];
            }
            const into = input.into_entity_id != null ? { entityId: input.into_entity_id } : input.into_name ? { name: input.into_name, type: input.into_type } : null;
            if (!into) return err("Pass into_entity_id or into_name.");
            return await writeOp({ op: "merge", into, entityIds: input.entity_ids, payees, apply: input.apply }, input.confirmation_token);
          }
          case "split":
            return await writeOp({ op: "split", entityId: input.entity_id, aliasIds: input.alias_ids, name: input.name, type: input.type, apply: input.apply }, input.confirmation_token);
          case "apply":
            return await writeOp({ op: "apply", entityIds: input.entity_ids }, input.confirmation_token);
          case "undo":
            return await writeOp({ op: "undo", batchId: input.batch_id }, input.confirmation_token);
          case "insights": {
            const directory = dek ? await loadDirectory(db, userId, dek) : [];
            const { currency, convert } = await makeSliceConverter(userId);
            const ins = await computePayeeInsights({
              executor: db,
              userId,
              dek,
              matcher: buildPayeeMatcher(directory),
              convert,
              currency,
              months: input.months,
              recentDays: input.recent_days,
              limit: input.limit,
            });
            const wantMerchants = input.merchants === true || input.period_from != null || input.period_to != null || input.entity_id != null || input.name != null;
            const merchants = wantMerchants
              ? await loadMerchantAnalytics({
                  executor: db,
                  userId,
                  dek,
                  period: input.period_from || input.period_to ? { from: input.period_from ?? "0000-01-01", to: input.period_to ?? "9999-12-31" } : null,
                  entityId: input.entity_id,
                  name: input.name,
                  limit: input.limit,
                })
              : null;
            if (input.entity_id != null || input.name != null) return dataResponse({ merchants, ...(dek ? {} : { note: NO_DEK_NOTE }) });
            return dataResponse({ ...ins, ...(merchants ? { merchants } : {}), ...(dek ? {} : { note: NO_DEK_NOTE }) });
          }
          case "lookalikes": {
            const o = await overview();
            const r = await loadLookalikes({ executor: db, userId, dek, overview: o, limit: input.limit ?? 50 });
            return dataResponse({
              suggestions: r.candidates.map((c) => ({
                payee: c.name,
                ...(c.spellings.length > 1 ? { spellings: c.spellings.map((x) => x.spelling) } : {}),
                count: c.count,
                total: c.total,
                looksLike: { entity_id: c.entity.id, name: c.entity.name, type: c.entity.type },
                confidence: c.confidence,
                reason: c.reason,
                ...(c.needsDecision ? { needsDecision: true, decisionReason: c.decisionReason } : {}),
                ...(c.remainder ? { remainder: c.remainder } : {}),
                ...(c.alternatives.length ? { alternatives: c.alternatives } : {}),
              })),
              total: r.candidates.length,
              unrenamed: r.unrenamed.map((u) => ({ entity_id: u.entityId, name: u.entityName, spellings: u.spellings, rows: u.rows })),
              ...(r.rejectedHidden ? { hiddenByRejections: r.rejectedHidden } : {}),
              howTo:
                "Same payee → op=propose [{canonical: looksLike.name, entity_id, aliases: [payee]}] (or alias_add, two-step). Same payee with a purpose in the name → op=move_remainder (payee becomes the entry's name, remainder goes to a tag or note; two-step). Different payee → op=reject_lookalike. unrenamed → op=apply entity_ids=[…]. Never decide needsDecision items without the user.",
              ...scanMeta(o),
            });
          }
          case "set_profile":
            if (input.website === undefined && input.logo === undefined && input.type === undefined && input.note === undefined) return err("Pass website, logo, type or note.");
            return await writeOp(
              { op: "update", entityId: input.entity_id, website: input.website, logo: input.logo, type: input.type, note: input.note, apply: false },
              input.confirmation_token,
            );
          case "move_remainder":
            return await writeOp(
              { op: "move_remainder", entityId: input.entity_id, payees: input.payees, remainder: input.remainder, target: input.target },
              input.confirmation_token,
            );
          case "reject_lookalike": {
            if (!dek) return err("Unlock required: answers are stored with your encryption key.");
            if (input.undo) return dataResponse({ removed: await cancelRejection(db, userId, dek, { payee: input.payee, entityId: input.entity_id }) });
            const ok = await rejectLookalike(db, userId, dek, input.payee, input.entity_id);
            if (!ok) return err(`No payee entity #${input.entity_id}.`);
            return dataResponse({ rejected: true, note: "Remembered: this spelling is not suggested for that entry again. reject_lookalike with undo=true cancels." });
          }
          case "explain": {
            const matcher = buildPayeeMatcher(dek ? await loadDirectory(db, userId, dek) : []);
            const x = explainPayeePair(input.a, input.b, matcher);
            const sideOut = (v: typeof x.a) => ({ payee: v.payee, key: v.key, core: v.core, block: v.block, typeGuess: v.type.type, typeReason: v.type.reason, ...(v.type.isPerson ? { person: true } : {}), entity: v.entity });
            return dataResponse({ verdict: x.verdict, score: x.score, reasons: x.reasons, a: sideOut(x.a), b: sideOut(x.b) });
          }
          case "review": {
            const o = await loadPayeeOverview({ executor: db, userId, dek, samples: 3 });
            const drafts = dek ? await listProposals(db, userId, dek, { status: "draft" }) : [];
            return dataResponse({ ...buildReviewPack(o, drafts, { limit: input.limit }), ...scanMeta(o) });
          }
          case "propose": {
            if (!dek) return err("Unlock required: proposals are stored encrypted. Sign in to Finlynq in the browser, then retry.");
            try {
              const res = await saveProposals({ executor: db, userId, dek, proposals: input.proposals.map((p) => ({ ...p, entityId: p.entity_id })), source: "mcp" });
              return dataResponse({
                saved: res.saved.map((x) => ({ proposal_id: x.id, canonical: x.canonical, ...(x.needsDecision ? { needsDecision: true } : {}), ...(x.notes.length ? { notes: x.notes } : {}) })),
                ...(res.rejected.length ? { rejected: res.rejected } : {}),
                note: "Saved as drafts — nothing changed. The user reviews them in Settings → Payees → AI review, or approve with op=approve (two-step) once they agree.",
              });
            } catch (e) {
              if (e instanceof PayeeDirectoryError) return err(e.message);
              throw e;
            }
          }
          case "proposals": {
            if (!dek) return err("Unlock required: proposals are stored encrypted.");
            const list = await listProposals(db, userId, dek, { status: input.status ?? "draft", limit: input.limit });
            return dataResponse({ proposals: list.map(proposalOut), total: list.length });
          }
          case "approve":
            return await opApprove(input.proposal_ids, input.confirmation_token);
          case "reject":
            return dataResponse({ rejected: await rejectProposals(db, userId, input.proposal_ids) });
        }
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    },
  );
}
