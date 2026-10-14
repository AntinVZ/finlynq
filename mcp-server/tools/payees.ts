/**
 * manage_payees — Payee Studio over MCP.
 *
 * Payees are per-row encrypted free text in transactions, recurring, staged,
 * SimpleFIN pending and the bank ledger, so every op reads and decrypts them
 * (src/lib/payees — the same code the Merchants section uses) and works in
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
import { decodeCursor, pageMeta, pageOf } from "../../src/lib/payees/mcp-page";
import { PAYEE_MCP_SCHEMA_VERSION } from "../../src/lib/payees/mcp-schema";
import { loadQueueCounts } from "../../src/lib/payees/queue";
import { computeOverviewCards, type OverviewPeriod } from "../../src/lib/payees/overview-cards";
import { matcherFor } from "../../src/lib/payees/resolve-hint";
import { registerManageTool } from "./_consolidate";
import { runInUserLocale } from "../../src/lib/i18n/server";
import { st } from "../../src/lib/i18n/current";
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
import { dictionaryMetaOf, getPayeeSettings, vocabularyOf } from "../../src/lib/payees/settings";
import { formatMerchantType, loadMerchantTypes, merchantTypeFilter, type MerchantType } from "../../src/lib/payees/merchant-types";
import { buildDictionary, dictionaryImportOps, dictionaryToJson, dictionaryToYaml, parseDictionary, planDictionaryImport, type Resolution } from "../../src/lib/payees/dictionary";
import { makeSliceConverter } from "../../src/lib/payees/service";
import { buildPayeeMatcher, loadDirectory } from "../../src/lib/payees/directory";
import { containsNormalized } from "../../src/lib/text-normalize";
import { payeeMatchKey } from "../../src/lib/payees/match-key";
import { loadLookalikes, loadMerchantAnalytics, loadPayeeOverview, suspiciousOf, type PayeeOverview } from "../../src/lib/payees/service";
import { cancelRejection, rejectLookalike } from "../../src/lib/payees/lookalikes";
import { mineIdentifiers, proposeMined } from "../../src/lib/payees/mine";
import { findWhose } from "../../src/lib/payees/whose";
import { loadPayeeNameMaps } from "../../src/lib/payees/scan";
import { unrecognizedGroups, type PayeeCluster, type PayeeGroup } from "../../src/lib/payees/overview";
import { identifierQueryRefusal } from "../../src/lib/payees/requisites";
import { describeOwnAccount, loadOwnAccounts, loadOwnMatcher } from "../../src/lib/payees/own-accounts";
import { BULK_DEFAULT_THRESHOLD, BULK_MAX, buildBulkCandidates, commitBulkRegistry, type BulkItem, type BulkRow } from "../../src/lib/payees/bulk-registry";

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
    ...(g.brand.removed.length ? { typeWords: g.brand.removed } : {}),
    ...(g.brand.typeOnly ? { noBrand: true } : {}),
    ...(g.bankOperation ? { bankOperation: g.bankOperation } : {}),
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

/**
 * P8 stage 9 (B7): a paged answer. Compact answers go without indentation;
 * both carry `truncated` and, when more rows exist, `next_cursor`.
 */
function pagedResponse(data: Record<string, unknown>, compact?: boolean) {
  if (!compact) return dataResponse(data);
  return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, data }) }] };
}

function entityOut(e: PayeeEntity, types: MerchantType[] = []) {
  const mt = e.merchantTypeId == null ? null : types.find((t) => t.id === e.merchantTypeId);
  return {
    entity_id: e.id,
    name: e.name,
    type: e.type,
    merchant_type: mt ? formatMerchantType(mt) : null,
    ...(e.website ? { website: e.website } : {}),
    has_logo: e.logo != null,
    ...(e.note ? { note: e.note } : {}),
    default_category_id: e.defaultCategoryId,
    aliases: e.aliases.map((a) => ({ alias_id: a.id, pattern: a.pattern, mode: a.mode, source: a.source })),
    identifiers: e.identifiers.map((i) => ({
      identifier_id: i.id,
      kind: i.kind,
      value: maskIdentifier(i.kind, i.value),
      ...(i.label ? { label: i.label } : {}),
      ...(i.bank ? { bank: i.bank } : {}),
      ...(i.currency ? { currency: i.currency } : {}),
      ...(i.isPrimary ? { primary: true } : {}),
      ...(i.isActive ? {} : { inactive: true }),
    })),
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
      changes: r.rows.changes.slice(0, 20).map((c) => ({ from: c.from, to: c.to, count: c.count, ...(c.caseOnly ? { caseOnly: true } : {}) })),
      ...(r.rows.conflicts.length ? { conflicts: r.rows.conflicts.slice(0, 20) } : {}),
    },
    ...(r.undo ? { undo: r.undo } : {}),
    ...(r.warnings.length ? { warnings: r.warnings } : {}),
    ...(r.blocked ? { blocked: r.blocked } : {}),
    ...(r.emptyReason ? { emptyReason: r.emptyReason } : {}),
    ...(r.typed.length ? { merchantTypeChanges: r.typed.slice(0, 50).map((t) => ({ entity_id: t.id, name: t.name, from: t.from, to: t.to, ...(t.via ? { matched_by: t.via } : {}) })) } : {}),
    ...(r.ownAccounts.added.length || r.ownAccounts.updated.length || r.ownAccounts.removed.length ? { ownAccounts: r.ownAccounts } : {}),
    ...(r.reviewed.length ? { reviewed: r.reviewed.map((x) => ({ entity_id: x.id, name: x.name, reviewed: x.reviewed })) } : {}),
    ...(r.skipped.length ? { merchantTypeSkipped: r.skipped.slice(0, 50).map((t) => ({ entity_id: t.id, name: t.name, reason: t.reason })) } : {}),
    ...(r.merchantTypes.added.length || r.merchantTypes.updated.length || r.merchantTypes.removed.length ? { merchantTypes: r.merchantTypes } : {}),
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

  async function opList(input: { view?: "all" | "unrecognized" | "entities"; search?: string; sort?: "count" | "total" | "name" | "last_date"; limit?: number; merchant_type?: string; cursor?: string; compact?: boolean }) {
    const o = await overview();
    const typeTest = input.merchant_type?.trim() ? merchantTypeFilter(input.merchant_type) : null;
    const typeOfEntity = new Map(o.entities.map((e) => [e.id, e.merchantType]));
    if (input.view === "entities") {
      let ents = o.entities;
      if (typeTest) ents = ents.filter((e) => typeTest(e.merchantType));
      if (input.search?.trim()) {
        const needle = input.search;
        const ids = new Set(o.directory.filter((e) => e.aliases.some((a) => containsNormalized(a.pattern, needle)) || containsNormalized(e.name, needle)).map((e) => e.id));
        ents = ents.filter((e) => ids.has(e.id));
      }
      if (input.sort === "name") ents = [...ents].sort((a, b) => a.name.localeCompare(b.name));
      else if (input.sort === "total") ents = [...ents].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      const page = pageOf(ents, { cursor: input.cursor, limit: input.limit ?? 100 });
      if (input.compact) {
        return pagedResponse(
          {
            entities: page.items.map((e) => ({ entity_id: e.id, name: e.name, type: e.type, merchant_type: e.merchantType ? formatMerchantType(e.merchantType) : null, count: e.count, total: e.total })),
            ...pageMeta(page),
            ...scanMeta(o),
          },
          true,
        );
      }
      return dataResponse({
        entities: page.items.map((e) => ({
          entity_id: e.id,
          name: e.name,
          type: e.type,
          merchant_type: e.merchantType ? formatMerchantType(e.merchantType) : null,
          ...(e.merchantTypeHint
            ? {
                merchant_type_hint: `${formatMerchantType(e.merchantTypeHint)} (${e.merchantTypeHint.reason}; ${e.merchantTypeHint.strength === "weak" ? "WEAK: matched through an alias, not the name" : "from the name"}; suggestion only — set it with op=update merchant_type after the user agrees)`,
              }
            : {}),
          ...(e.merchantTypeMixed ? { merchant_type_mixed: `${e.merchantTypeMixed} — no automatic type` } : {}),
          count: e.count,
          total: e.total,
          lastDate: e.lastDate,
          aliases: e.aliasCount,
          identifiers: e.identifierCount,
        })),
        ...pageMeta(page),
        ...scanMeta(o),
      });
    }
    let groups = input.view === "unrecognized" ? unrecognizedGroups(o.groups) : o.groups.filter((g) => g.key);
    if (typeTest) groups = groups.filter((g) => typeTest(g.entityId == null ? null : (typeOfEntity.get(g.entityId) ?? null)));
    if (input.search?.trim()) {
      const needle = input.search;
      groups = groups.filter((g) => g.spellings.some((s) => containsNormalized(s.spelling, needle)) || (g.entityName != null && containsNormalized(g.entityName, needle)));
    }
    const sort = input.sort ?? "count";
    if (sort === "total") groups = [...groups].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    else if (sort === "name") groups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "last_date") groups = [...groups].sort((a, b) => (b.lastDate ?? "").localeCompare(a.lastDate ?? ""));
    const page = pageOf(groups, { cursor: input.cursor, limit: input.limit ?? 100 });
    const emptyPayee = o.groups.find((g) => !g.key);
    return pagedResponse(
      {
        payees: page.items.map((g) =>
          input.compact ? { name: g.name, key: g.key, count: g.count, total: g.total, ...(g.entityId != null ? { entity_id: g.entityId } : {}) } : groupOut(g),
        ),
        ...pageMeta(page),
        ...(page.truncated ? { more: `Showing ${page.items.length} of ${groups.length}; pass next_cursor for the next page, or \`search\`.` } : {}),
        ...(emptyPayee ? { blankPayeeTransactions: emptyPayee.count } : {}),
        ...scanMeta(o),
      },
      input.compact,
    );
  }

  async function opClusters(input: { min_confidence?: number; include_needs_decision?: boolean; limit?: number; cursor?: string; compact?: boolean }) {
    const o = await overview();
    const min = input.min_confidence ?? 0;
    let clusters = o.clusters.filter((c) => c.confidence >= min);
    if (input.include_needs_decision === false) clusters = clusters.filter((c) => !c.needsDecision);
    const page = pageOf(clusters, { cursor: input.cursor, limit: input.limit ?? 50 });
    return pagedResponse(
      {
        clusters: page.items.map((c) =>
          input.compact
            ? { cluster_id: c.id, confidence: c.confidence, ...(c.needsDecision ? { needsDecision: true } : {}), suggestedName: c.suggestedName, count: c.count, members: c.groups.map((g) => g.name) }
            : clusterOut(c),
        ),
        ...pageMeta(page),
        needsDecision: clusters.filter((c) => c.needsDecision).length,
        ...scanMeta(o),
      },
      input.compact,
    );
  }

  /** P8 stage 9: the Merchants overview cards — coverage, uncovered top, new, large checks, duplicates, silent, untyped. */
  async function opCoverage(period: OverviewPeriod) {
    if (!dek) return err("Unlock required: payees are encrypted. Sign in to Finlynq in the browser, then retry.");
    const [matcher, own, settings, converter] = await Promise.all([
      matcherFor({ executor: db, userId, dek }),
      loadOwnMatcher(db, userId, dek),
      getPayeeSettings(db, userId),
      makeSliceConverter(userId),
    ]);
    const cards = await computeOverviewCards({ executor: db, userId, dek, matcher, own, vocab: vocabularyOf(settings), convert: converter.convert, currency: converter.currency, period });
    return dataResponse({ ...cards, note: "Channels, bank operations and own-account transfers are left out. Large checks: above Q3 + 1.5·IQR of the same merchant's earlier payments." });
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

  /** P6.2 (82): create the chosen bulk rows as directory entries — two-step, one batch. */
  async function bulkCreate(items: BulkItem[], token: string | undefined) {
    if (!dek) return err("Unlock required: payee changes need the encryption key. Sign in to Finlynq in the browser, then retry.");
    try {
      const o = await overview();
      const preview = await commitBulkRegistry({ executor: db, userId, dek, overview: o, items, actor: "mcp", dryRun: true });
      const payload = { op: "bulk_create", items, fingerprint: preview.fingerprint, created: preview.bulk.created };
      const out = (r: typeof preview) => ({ ...opOut(r), bulk: r.bulk });
      if (!token) return dataResponse({ preview: true, ...out(preview), confirmationToken: signPreviewToken(userId, "manage_payees_bulk_create", payload) });
      const check = verifyPreviewToken(token, userId, "manage_payees_bulk_create", payload);
      if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. The data may have changed; re-call without confirmation_token to refresh the preview.`);
      const done = await commitBulkRegistry({ executor: db, userId, dek, overview: o, items, actor: "mcp" });
      return dataResponse({
        ...out(done),
        next: `${done.bulk.pendingRows} stored row(s) still carry other spellings: preview op=apply entity_ids=[…] (or the web Apply) to rename them.`,
        ...(done.batchId != null ? { undoWith: `manage_payees op=undo batch_id=${done.batchId} (within 30 days)` } : {}),
      });
    } catch (e) {
      if (e instanceof PayeeDirectoryError || e instanceof PayeeBatchError) return err(e.message);
      throw e;
    }
  }
  const bulkRowOut = (r: BulkRow) => ({
    row_id: r.rowId,
    name: r.name,
    ...(r.merchantTypeHint ? { merchant_type_hint: `${r.merchantTypeHint.group} → ${r.merchantTypeHint.name}`, hint_reason: r.merchantTypeHint.reason } : {}),
    spellings: r.spellings.slice(0, 20),
    rows: r.rows,
    transactions: r.transactions,
    confidence: r.confidence,
    ...(r.personReason ? { person_reason: r.personReason } : {}),
  });

  async function opEntity(entityId: number) {
    const o = await overview();
    const e = o.directory.find((x) => x.id === entityId);
    if (!e) return err(`No payee entity #${entityId}. Use op=list view=entities.`);
    const pending = await planPayeeApply({ executor: db, userId, dek, matcher: o.matcher, entityIds: new Set([entityId]) });
    const history = await listPayeeBatches(db, userId, { entityId, limit: 20 });
    return dataResponse({
      entity: entityOut(e, o.merchantTypes),
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

  const identifierDetailsArgs = {
    label: z.string().max(60).nullable().optional().describe("e.g. \"Mono black\", \"rent account\"."),
    bank: z.string().max(60).nullable().optional(),
    currency: z.string().max(3).nullable().optional().describe("ISO code, e.g. UAH."),
    is_primary: z.boolean().optional(),
    is_active: z.boolean().optional(),
  };
  const tokenArg = z
    .string()
    .optional()
    .describe("Token from the preview call with the same arguments. Omit to preview; pass verbatim to commit. Single-use; 5-minute TTL.");
  const merchantTypeArg = z
    .union([z.number().int().positive(), z.string().min(1).max(170)])
    .nullable()
    .optional()
    .describe("Merchant type (one per payee): merchant_type_id, \"Group → Position\" (created if missing), or a unique position / group name from op=merchant_types; null clears. Never set it without the user's OK.");
  const merchantTypeFilterArg = z.string().optional().describe("Only payees whose directory entry has this merchant type: a group (all positions), a position, \"Group → Position\", or \"без типу\".");
  const typeArg = z.enum(PAYEE_TYPES).optional().describe("Entity type, secondary to merchant_type: retail | service | bank | government | person | sole_proprietor | company | other. Omit it: it is derived from the name and the merchant type (\"Особи і ФОП\" → person / sole_proprietor; a person-looking name stays a person).");
  const aliasArg = z
    .array(z.union([z.string(), z.object({ pattern: z.string(), mode: z.enum(ALIAS_MODES).optional() })]))
    .optional()
    .describe("Spellings that resolve to the payee: a string (exact match — case, apostrophes, Latin/Cyrillic and terminal noise ignored) or {pattern, mode: exact|contains|regex}.");
  const identifierArg = z
    .array(z.object({ kind: z.enum(IDENTIFIER_KINDS), value: z.string() }))
    .optional()
    .describe("Requisites: iban | tax_id | edrpou | card_last4 (last 4 digits or a mask; a full card number is refused) | crypto_wallet.");
  const cursorArg = z.string().max(200).optional().describe("next_cursor from the previous page.");
  const compactArg = z.boolean().optional().describe("Only names, keys, counts and sums (smaller answer).");
  const applyArg = z.boolean().optional().describe("Also rename stored payees to the canonical name (default true).");
  const ownAccountArgs = {
    iban: z.string().max(40).nullable().optional(),
    card: z.string().max(30).nullable().optional().describe("Last 4 digits or a mask (\"**** 1234\"). Never a full card number."),
    bank: z.string().max(60).nullable().optional(),
    label: z.string().max(60).nullable().optional(),
    currency: z.string().max(3).nullable().optional(),
    owner: z.enum(["me", "spouse", "business"]).optional().describe("me (default), spouse, business."),
  };
  const toAliases = (a: Array<string | { pattern: string; mode?: (typeof ALIAS_MODES)[number] }> | undefined) =>
    (a ?? []).map((x) => (typeof x === "string" ? { pattern: x } : x));

  registerManageTool(
    server,
    "manage_payees",
    "Review and clean up payees (merchants, people, services). Reads: list, clusters, get, coverage, queue, batches, insights, merchant_types, review, proposals, explain, lookalikes, suspicious, own_accounts, bulk_review, mine_identifiers, whose, dictionary_export. AI flow: review → propose (drafts) → user approves / rejects. Writes: create, update, set_profile, set_merchant_type, merchant_types_edit, alias_add, alias_remove, identifiers, merge, split, apply, move_remainder, apply_default_category, mark_reviewed, delete, own_accounts_edit, bulk_create, reject_lookalike, propose_identifiers, dictionary_import, undo. Every write is TWO-STEP: call without confirmation_token to preview (+ token), then repeat with it; each commit is one batch, undoable 30 days. Never merge a person with a merchant unless the user says so. Bank-statement rows never change. Details: finlynq_help topic=payees.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("list"),
        view: z.enum(["all", "unrecognized", "entities"]).optional().describe("all (default), unrecognized = payees not linked to a directory entity, entities = the directory itself."),
        search: z.string().optional().describe("Only payees with a spelling containing this text."),
        sort: z.enum(["count", "total", "name", "last_date"]).optional().describe("Order: count (default), total (by absolute amount), name, last_date."),
        limit: z.number().int().positive().max(5000).optional().describe("Most payees to return (default 100)."),
        merchant_type: merchantTypeFilterArg,
        cursor: cursorArg,
        compact: compactArg,
      }),
      z.object({
        op: z.literal("clusters"),
        min_confidence: z.number().min(0).max(1).optional().describe("Only clusters at or above this confidence (0–1)."),
        include_needs_decision: z.boolean().optional().describe("false hides clusters containing a private person / sole proprietor (default true)."),
        limit: z.number().int().positive().max(1000).optional().describe("Most clusters to return (default 50)."),
        cursor: cursorArg,
        compact: compactArg,
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
        merchant_type: merchantTypeArg,
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
        merchant_type: merchantTypeArg,
        apply: applyArg,
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("merchant_types"),
      }),
      z.object({
        op: z.literal("merchant_types_edit"),
        add: z.array(z.object({ group: z.string().min(1).max(80), name: z.string().min(1).max(80).optional().describe("Position; omit for a one-position group."), default_category_id: z.number().int().positive().nullable().optional() })).optional(),
        update: z.array(z.object({ merchant_type_id: z.number().int().positive(), group: z.string().min(1).max(80).optional(), name: z.string().min(1).max(80).optional(), sort: z.number().int().min(0).optional(), default_category_id: z.number().int().positive().nullable().optional() })).optional(),
        remove: z.array(z.number().int().positive()).optional().describe("merchant_type_id values; entries using them lose the type (undoable)."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("set_merchant_type"),
        merchant_type: z.union([z.number().int().positive(), z.string().min(1).max(170)]).nullable().describe("The type to set (id, \"Group → Position\", or a unique position / group name); null clears."),
        entity_ids: z.array(z.number().int().positive()).max(5000).optional().describe("These entries…"),
        type_word: z.string().min(1).max(60).optional().describe("…or every entry whose canonical NAME carries this type word or a synonym (аптека = apteka = pharmacy), e.g. \"ресторан\". Alias-only matches and mixed entries are listed as skipped, not changed."),
        only_untyped: z.boolean().optional().describe("Leave entries that already have a type alone."),
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
        add: z
          .array(z.object({ kind: z.enum(IDENTIFIER_KINDS), value: z.string(), ...identifierDetailsArgs }))
          .optional()
          .describe("Requisites to add. tax_id = ІПН/РНОКПП, 10 digits (people / ФОП); edrpou = 8 digits (legal entities); card_last4 keeps the last 4 digits only. A failed check digit is a warning, not a refusal."),
        update: z.array(z.object({ identifier_id: z.number().int().positive(), ...identifierDetailsArgs })).optional().describe("Change label / bank / currency / is_primary / is_active of existing requisites."),
        deactivate: z.array(z.number().int().positive()).optional().describe("identifier_id values to mark inactive (kept for history and search)."),
        remove: z.array(z.number().int().positive()).optional().describe("identifier_id values to remove."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("merge"),
        into_entity_id: z.number().int().positive().optional().describe("Merge into this existing entity…"),
        into_name: z.string().optional().describe("…or into a new entity with this canonical name."),
        into_type: typeArg,
        into_merchant_type: merchantTypeArg.describe("Merchant type of the NEW entity (with into_name): merchant_type_id, \"Group → Position\" (created if missing), or a unique position / group name. Never set it without the user's OK."),
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
        merchant_type: merchantTypeFilterArg,
        merchant_type_group_by: z.enum(["group", "position"]).optional().describe("Add byMerchantType: spend per merchant-type group or position (untyped = \"Без типу\")."),
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
        merchant_type: merchantTypeArg,
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("dictionary_export"),
        format: z.enum(["json", "yaml"]).optional().describe("json (default) or yaml."),
      }),
      z.object({
        op: z.literal("dictionary_import"),
        content: z.string().min(1).max(5_000_000).describe("A finlynq-payee-dictionary file (JSON or YAML)."),
        resolutions: z.record(z.string(), z.string()).optional().describe("Per conflicting entry index: \"skip\" or \"merge:<entity_id>\" (from the preview)."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("whose"),
        identifier: z.string().min(1).describe("IBAN, card (\"5168 **** 1234\", \"****1234\", \"1234\"), ІПН (10 digits) or ЄДРПОУ (8)."),
      }),
      z.object({
        op: z.literal("mine_identifiers"),
        limit: z.number().int().positive().max(1000).optional().describe("Most suggestions (default 100)."),
      }),
      z.object({
        op: z.literal("propose_identifiers"),
        refs: z.array(z.string()).min(1).max(200).describe("`ref` values from mine_identifiers (suggestions or links)."),
      }),
      z.object({
        op: z.literal("lookalikes"),
        limit: z.number().int().positive().max(1000).optional().describe("Most suggestions (default 50)."),
      }),
      z.object({
        op: z.literal("apply_default_category"),
        entity_id: z.number().int().positive().describe("The directory entry."),
        category_id: z.number().int().positive().optional().describe("Default: the entry's default category, else its merchant type's."),
        confirmation_token: tokenArg,
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
        cursor: cursorArg,
        compact: compactArg,
      }),
      z.object({
        op: z.literal("coverage"),
        period: z.enum(["30d", "90d", "1y"]).optional().describe("Window (default 90d)."),
      }),
      z.object({
        op: z.literal("queue"),
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
        op: z.literal("suspicious"),
        include_reviewed: z.boolean().optional().describe("Also list entries already marked as checked."),
        limit: z.number().int().positive().max(1000).optional().describe("Most entries (default 100)."),
      }),
      z.object({
        op: z.literal("mark_reviewed"),
        entity_ids: z.array(z.number().int().positive()).min(1).max(500),
        reviewed: z.boolean().optional().describe("false clears the mark (default true)."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("delete"),
        entity_id: z.number().int().positive().describe("The directory entry to remove; its transactions keep their payees as they are."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("own_accounts"),
      }),
      z.object({
        op: z.literal("bulk_review"),
        threshold: z.number().min(0).max(1).optional().describe(`Least cluster confidence (default ${BULK_DEFAULT_THRESHOLD}).`),
        limit: z.number().int().positive().max(2000).optional().describe("Most rows (default 500)."),
      }),
      z.object({
        op: z.literal("bulk_create"),
        items: z
          .array(z.object({ row_id: z.string().min(1).max(80), name: z.string().min(1).max(200).optional(), merchant_type: merchantTypeArg }))
          .min(1)
          .max(BULK_MAX)
          .describe(`Rows from bulk_review the user kept (at most ${BULK_MAX}); name = edited name; merchant_type only when the user confirmed it.`),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("own_accounts_edit"),
        add: z.array(z.object(ownAccountArgs)).max(50).optional().describe("New own accounts / cards: iban and / or card (LAST 4 digits or a mask; a full number is refused)."),
        update: z.array(z.object({ id: z.number().int().positive(), ...ownAccountArgs })).max(50).optional().describe("Changed fields by id (from op=own_accounts)."),
        remove: z.array(z.number().int().positive()).max(50).optional(),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("undo"),
        batch_id: z.number().int().positive().describe("A batch_id from a write result or op=batches."),
        confirmation_token: tokenArg,
      }),
    ]),
    // P8: answers (warnings, reasons, errors) in the user's interface language.
    (input) => runInUserLocale(db, userId, null, async () => {
      try {
        switch (input.op) {
          case "list":
            return await opList(input);
          case "clusters":
            return await opClusters(input);
          case "coverage":
            return await opCoverage(input.period ?? "90d");
          case "queue": {
            const q = await loadQueueCounts({ executor: db, userId, dek });
            return dataResponse({
              ...q,
              where: "Merchants → Черга (/merchants?tab=queue): clusters = op=clusters, lookalikes = op=lookalikes, drafts = op=proposals, suspicious = op=suspicious, unrecognized = op=review.",
              schema: PAYEE_MCP_SCHEMA_VERSION,
            });
          }
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
              { op: "create", name: input.name, type: input.type, note: input.note, defaultCategoryId: input.default_category_id, merchantType: input.merchant_type, aliases: toAliases(input.aliases), identifiers: input.identifiers, apply: input.apply },
              input.confirmation_token,
            );
          case "update":
            return await writeOp(
              { op: "update", entityId: input.entity_id, name: input.name, type: input.type, note: input.note, defaultCategoryId: input.default_category_id, merchantType: input.merchant_type, apply: input.apply },
              input.confirmation_token,
            );
          case "merchant_types": {
            const types = await loadMerchantTypes(db, userId);
            const used = new Map<number, number>();
            for (const e of dek ? await loadDirectory(db, userId, dek) : []) if (e.merchantTypeId != null) used.set(e.merchantTypeId, (used.get(e.merchantTypeId) ?? 0) + 1);
            return dataResponse({
              merchant_types: types.map((t) => ({ merchant_type_id: t.id, group: t.group, name: t.name, label: formatMerchantType(t), entries: t.id == null ? 0 : (used.get(t.id) ?? 0), ...(t.defaultCategoryId != null ? { default_category_id: t.defaultCategoryId } : {}) })),
              ...(types.some((t) => t.id == null) ? { note: "The built-in starting set (no ids yet): refer to types by \"Group → Position\"; it is stored on the first change." } : {}),
            });
          }
          case "merchant_types_edit":
            return await writeOp(
              {
                op: "merchant_types",
                add: input.add?.map((a) => ({ group: a.group, name: a.name, defaultCategoryId: a.default_category_id })),
                update: input.update?.map((u) => ({ id: u.merchant_type_id, group: u.group, name: u.name, sort: u.sort, defaultCategoryId: u.default_category_id })),
                remove: input.remove,
              },
              input.confirmation_token,
            );
          case "set_merchant_type":
            if (!input.entity_ids?.length && !input.type_word?.trim()) return err("Pass entity_ids or type_word.");
            return await writeOp(
              { op: "set_merchant_type", merchantType: input.merchant_type, entityIds: input.entity_ids, typeWord: input.type_word, onlyUntyped: input.only_untyped },
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
          case "identifiers": {
            if (!input.add?.length && !input.remove?.length && !input.update?.length && !input.deactivate?.length) return await opEntity(input.entity_id);
            const det = (d: { label?: string | null; bank?: string | null; currency?: string | null; is_primary?: boolean; is_active?: boolean }) => ({
              label: d.label,
              bank: d.bank,
              currency: d.currency,
              isPrimary: d.is_primary,
              isActive: d.is_active,
            });
            return await writeOp(
              {
                op: "identifiers",
                entityId: input.entity_id,
                add: input.add?.map((a) => ({ kind: a.kind, value: a.value, ...det(a) })),
                update: input.update?.map((u) => ({ id: u.identifier_id, ...det(u) })),
                deactivate: input.deactivate,
                remove: input.remove,
              },
              input.confirmation_token,
            );
          }
          case "whose": {
            const { accounts } = await loadPayeeNameMaps(db, userId, dek);
            const r = await findWhose({ executor: db, userId, dek, identifier: input.identifier, accountNames: accounts });
            if (!r) return err(identifierQueryRefusal(input.identifier) ?? "Not a requisite: pass an IBAN, a card (last 4 digits or a mask), a 10-digit ІПН or an 8-digit ЄДРПОУ.");
            return dataResponse({
              query: r.query,
              candidates: r.candidates.map((c) => ({
                ...(c.entity ? { entity_id: c.entity.id, type: c.entity.type } : {}),
                payee: c.payee,
                evidence: c.evidence,
                ...(c.holdsRequisite ? { inDirectory: true } : {}),
                transactions: c.transactions,
                firstDate: c.firstDate,
                lastDate: c.lastDate,
                totals: c.totals,
                typicalAmount: c.typicalAmount,
                accounts: c.accounts.map((a) => a.name),
                examples: c.examples,
              })),
              ...(r.own ? { yourAccount: st("srv.mcp.yourAccount", { account: r.own.description }) } : {}),
              ...(r.hints.length ? { hints: r.hints } : {}),
              bankRowsMentioning: r.bankRows,
              ...(r.truncated ? { truncated: true } : {}),
              ...(dek ? {} : { note: NO_DEK_NOTE }),
            });
          }
          case "own_accounts": {
            if (!dek) return err("Unlock required: own accounts are encrypted.");
            const list = await loadOwnAccounts(db, userId, dek);
            return dataResponse({
              own_accounts: list.map((a) => ({
                id: a.id,
                ...(a.iban ? { iban: maskIdentifier("iban", a.iban) } : {}),
                ...(a.cardLast4 ? { card: `•••• ${a.cardLast4}` } : {}),
                bank: a.bank,
                label: a.label,
                currency: a.currency,
                owner: a.owner,
                description: describeOwnAccount(a),
              })),
              howTo: "These are the user's own accounts and cards: never suggested as a merchant's requisites, transfers to them are not spend. Edit with op=own_accounts_edit (two-step, undoable).",
            });
          }
          case "bulk_review": {
            const o = await overview();
            const c = buildBulkCandidates(o, { threshold: input.threshold });
            const limit = input.limit ?? 500;
            return dataResponse({
              threshold: c.threshold,
              rows: c.rows.slice(0, limit).map(bulkRowOut),
              total: c.rows.length,
              people: c.people.slice(0, 200).map(bulkRowOut),
              left: c.left,
              howTo: `Show the table to the user; they untick rows, edit names, confirm types (hints are never applied by themselves). Then op=bulk_create items=[{row_id, name?, merchant_type?}] (two-step, ONE batch, undoable 30 days; at most ${BULK_MAX} per set). People / ФОП are never in a set: decide them one by one (op=create / op=merge). Stored payees are not renamed: op=apply afterwards.`,
              ...scanMeta(o),
            });
          }
          case "bulk_create":
            return await bulkCreate(
              input.items.map((x) => ({ rowId: x.row_id, ...(x.name ? { name: x.name } : {}), ...(x.merchant_type != null ? { merchantType: x.merchant_type } : {}) })),
              input.confirmation_token,
            );
          case "own_accounts_edit":
            return await writeOp(
              {
                op: "own_accounts",
                add: input.add,
                update: input.update,
                remove: input.remove,
              },
              input.confirmation_token,
            );
          case "mine_identifiers": {
            if (!dek) return err("Unlock required: payees and notes are encrypted.");
            const directory = await loadDirectory(db, userId, dek);
            const r = await mineIdentifiers({ executor: db, userId, dek, matcher: buildPayeeMatcher(directory), directory, limit: input.limit ?? 100 });
            return dataResponse({
              suggestions: r.suggestions.map((x) => ({
                ref: x.ref,
                payee: x.counterparty.name,
                ...(x.counterparty.entityId != null ? { entity_id: x.counterparty.entityId } : {}),
                kind: x.kind,
                value: x.masked,
                ...(x.valid ? {} : { checkDigitWarning: true }),
                strength: x.kind === "card_last4" ? "weak" : "strong",
                rows: x.rows,
                firstDate: x.firstDate,
                lastDate: x.lastDate,
                ...(x.ownedBy.length ? { alsoOn: x.ownedBy } : {}),
                example: x.example,
              })),
              links: r.links.map((l) => ({ ref: l.ref, payee: l.payee, looksLike: { entity_id: l.entity.id, name: l.entity.name }, via: l.via, rows: l.rows })),
              scanned: r.scanned,
              truncated: r.truncated,
              ...(r.ownSkipped ? { ownSkipped: r.ownSkipped, ownNote: "Requisites of the user's own accounts / cards are left out." } : {}),
              howTo: "Values are masked. To keep some, call op=propose_identifiers refs=[…] — they become DRAFT proposals the user approves (AI review page or op=approve). A card's last 4 digits are weak evidence: never treat them as proof on their own.",
            });
          }
          case "propose_identifiers": {
            if (!dek) return err("Unlock required: proposals are stored encrypted.");
            const directory = await loadDirectory(db, userId, dek);
            const r = await mineIdentifiers({ executor: db, userId, dek, matcher: buildPayeeMatcher(directory), directory, limit: 5000 });
            const res = await proposeMined({ executor: db, userId, dek, report: r, refs: input.refs, source: "mcp" });
            return dataResponse({
              saved: res.saved.map((x) => ({ proposal_id: x.id, canonical: x.canonical, ...(x.notes.length ? { notes: x.notes } : {}) })),
              ...(res.rejected.length ? { rejected: res.rejected } : {}),
              ...(res.missing.length ? { missing: res.missing, note: "Some refs no longer match (the data changed); re-run op=mine_identifiers." } : {}),
            });
          }
          case "merge": {
            let payees = input.payees ?? [];
            if (input.cluster_ids?.length) {
              const fromClusters = await clusterPayees(input.cluster_ids);
              if (typeof fromClusters === "string") return err(fromClusters);
              payees = [...payees, ...fromClusters];
            }
            const into = input.into_entity_id != null ? { entityId: input.into_entity_id } : input.into_name ? { name: input.into_name, type: input.into_type, merchantType: input.into_merchant_type ?? undefined } : null;
            if (!into) return err("Pass into_entity_id or into_name.");
            return await writeOp({ op: "merge", into, entityIds: input.entity_ids, payees, apply: input.apply }, input.confirmation_token);
          }
          case "split":
            return await writeOp({ op: "split", entityId: input.entity_id, aliasIds: input.alias_ids, name: input.name, type: input.type, apply: input.apply }, input.confirmation_token);
          case "apply":
            return await writeOp({ op: "apply", entityIds: input.entity_ids }, input.confirmation_token);
          case "undo":
            return await writeOp({ op: "undo", batchId: input.batch_id }, input.confirmation_token);
          case "suspicious": {
            const o = await overview();
            const list = suspiciousOf(o, { includeReviewed: input.include_reviewed });
            return dataResponse({
              entries: list.slice(0, input.limit ?? 100).map((x) => ({ entity_id: x.id, name: x.name, reasons: x.reasons.map((r) => r.reason), transactions: x.count, spellings: x.spellings })),
              total: list.length,
              howTo: "Nothing changes by itself. Ask the user, then: op=update name=… (rename), op=merge into_entity_id=… entity_ids=[id] (merge), op=delete entity_id=… (removes the entry; rows stay), or op=mark_reviewed entity_ids=[…] (checked; not listed again). All two-step, undoable.",
              ...scanMeta(o),
            });
          }
          case "mark_reviewed":
            return await writeOp({ op: "mark_reviewed", entityIds: input.entity_ids, reviewed: input.reviewed }, input.confirmation_token);
          case "delete":
            return await writeOp({ op: "delete", entityId: input.entity_id }, input.confirmation_token);
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
              vocab: vocabularyOf(await getPayeeSettings(db, userId)),
              own: await loadOwnMatcher(db, userId, dek),
              ...(input.merchant_type || input.merchant_type_group_by
                ? await (async () => {
                    const types = await loadMerchantTypes(db, userId);
                    const byEntity = new Map(directory.map((e) => [e.id, e.merchantTypeId == null ? null : (types.find((t) => t.id === e.merchantTypeId) ?? null)]));
                    return { merchantTypeOf: (id: number) => byEntity.get(id) ?? null, merchantType: input.merchant_type, groupByMerchantType: input.merchant_type_group_by };
                  })()
                : {}),
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
          case "dictionary_export": {
            if (!dek) return err("Unlock required: the directory is encrypted. Sign in to Finlynq in the browser, then retry.");
            const dict = buildDictionary(await loadDirectory(db, userId, dek), new Date(), await loadMerchantTypes(db, userId), dictionaryMetaOf(await getPayeeSettings(db, userId)));
            return dataResponse({
              format: input.format ?? "json",
              content: input.format === "yaml" ? dictionaryToYaml(dict) : dictionaryToJson(dict),
              entries: dict.entries.length,
              skipped: dict.skipped,
              note: "Shareable data only: names, aliases, types, websites and public company ids (EDRPOU; IBAN for company / bank / government). Never amounts, dates, notes, categories, logos, private persons / sole proprietors, tax ids or card digits.",
            });
          }
          case "dictionary_import": {
            if (!dek) return err("Unlock required: the directory is encrypted. Sign in to Finlynq in the browser, then retry.");
            let parsed: ReturnType<typeof parseDictionary>;
            try {
              parsed = parseDictionary(input.content);
            } catch (e) {
              return err(e instanceof Error ? e.message : String(e));
            }
            const resolutions: Record<number, Resolution> = {};
            for (const [k, v] of Object.entries(input.resolutions ?? {})) {
              if (!/^\d+$/.test(k) || !(v === "skip" || v === "create" || /^merge:\d+$/.test(v))) return err(`Bad resolution "${k}": "${v}". Use "skip" or "merge:<entity_id>".`);
              resolutions[Number(k)] = v as Resolution;
            }
            const plan = planDictionaryImport(parsed.entries, await loadDirectory(db, userId, dek), resolutions);
            const counts = { create: 0, merge: 0, unchanged: 0, skip: 0, conflict: 0 };
            for (const p of plan) counts[p.action]++;
            const planOut = plan.map((p) => ({
              index: p.index,
              name: p.name,
              action: p.action,
              ...(p.target ? { target: p.target } : {}),
              ...(p.candidates.length && p.action === "conflict" ? { candidates: p.candidates } : {}),
              ...(p.newAliases.length ? { newAliases: p.newAliases.map((a) => a.pattern) } : {}),
              ...(p.newIdentifiers.length ? { newIdentifiers: p.newIdentifiers.map((i) => ({ kind: i.kind, value: maskIdentifier(i.kind, i.value) })) } : {}),
              ...(p.newWebsite ? { website: p.newWebsite } : {}),
              ...(p.note ? { note: p.note } : {}),
            }));
            const { ops, labels } = dictionaryImportOps(plan);
            const payload = { plan: plan.map((p) => `${p.index}:${p.action}:${p.target?.id ?? ""}:${p.newAliases.length}:${p.newIdentifiers.length}:${p.newWebsite ?? ""}`), resolutions };
            if (!input.confirmation_token) {
              if (counts.conflict) return dataResponse({ preview: true, plan: planOut, counts, errors: parsed.errors, note: "Conflicts need a decision: pass resolutions {\"<index>\": \"skip\" | \"merge:<entity_id>\"} and preview again. No token issued." });
              if (!ops.length) return dataResponse({ preview: true, plan: planOut, counts, errors: parsed.errors, note: "Nothing to import." });
              return dataResponse({ preview: true, plan: planOut, counts, errors: parsed.errors, confirmationToken: signPreviewToken(userId, "manage_payees_dictionary_import", payload) });
            }
            if (counts.conflict) return err("Refusing to import: some entries still conflict. Preview again with resolutions.");
            const check = verifyPreviewToken(input.confirmation_token, userId, "manage_payees_dictionary_import", payload);
            if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-call without confirmation_token to refresh the preview.`);
            try {
              const done = await executePayeeOp({ executor: db, userId, dek, actor: "mcp", op: { op: "bulk", kind: "dictionary_import", ops, labels } });
              return dataResponse({ imported: counts, batch_id: done.batchId, ...(done.batchId != null ? { undoWith: `manage_payees op=undo batch_id=${done.batchId} (within 30 days)` } : {}), note: "Stored payees are not renamed; use op=apply to rename them." });
            } catch (e) {
              if (e instanceof PayeeDirectoryError || e instanceof PayeeBatchError) return err(e.message);
              throw e;
            }
          }
          case "set_profile":
            if (input.website === undefined && input.logo === undefined && input.type === undefined && input.note === undefined && input.merchant_type === undefined) return err("Pass website, logo, type, note or merchant_type.");
            return await writeOp(
              { op: "update", entityId: input.entity_id, website: input.website, logo: input.logo, type: input.type, note: input.note, merchantType: input.merchant_type, apply: false },
              input.confirmation_token,
            );
          case "apply_default_category":
            return await writeOp({ op: "apply_default_category", entityId: input.entity_id, categoryId: input.category_id }, input.confirmation_token);
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
            const x = explainPayeePair(input.a, input.b, matcher, vocabularyOf(await getPayeeSettings(db, userId)));
            const sideOut = (v: typeof x.a) => ({
              payee: v.payee,
              key: v.key,
              core: v.core,
              block: v.block,
              brand: v.brandLine,
              ...(v.bankOperation ? { bankOperation: v.bankOperation } : {}),
              typeGuess: v.type.type,
              typeReason: v.type.reason,
              ...(v.type.isPerson ? { person: true } : {}),
              entity: v.entity,
            });
            return dataResponse({ verdict: x.verdict, score: x.score, reasons: x.reasons, a: sideOut(x.a), b: sideOut(x.b) });
          }
          case "review": {
            const o = await loadPayeeOverview({ executor: db, userId, dek, samples: input.compact ? 0 : 3 });
            const drafts = dek ? await listProposals(db, userId, dek, { status: "draft" }) : [];
            return pagedResponse({ ...buildReviewPack(o, drafts, { limit: input.limit, offset: decodeCursor(input.cursor), compact: input.compact }), ...scanMeta(o) }, input.compact);
          }
          case "propose": {
            if (!dek) return err("Unlock required: proposals are stored encrypted. Sign in to Finlynq in the browser, then retry.");
            try {
              const res = await saveProposals({ executor: db, userId, dek, proposals: input.proposals.map((p) => ({ ...p, entityId: p.entity_id })), source: "mcp" });
              return dataResponse({
                saved: res.saved.map((x) => ({ proposal_id: x.id, canonical: x.canonical, ...(x.needsDecision ? { needsDecision: true } : {}), ...(x.notes.length ? { notes: x.notes } : {}) })),
                ...(res.rejected.length ? { rejected: res.rejected } : {}),
                note: "Saved as drafts — nothing changed. The user reviews them in Merchants → AI review (/merchants/review), or approve with op=approve (two-step) once they agree.",
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
    }),
  );
}
