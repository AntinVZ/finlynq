/**
 * manage_payees — Payee Studio over MCP.
 *
 * Payees are per-row encrypted free text in transactions, recurring, staged,
 * SimpleFIN pending and the bank ledger, so every op reads and decrypts them
 * (src/lib/payees — the same code Settings → Payees uses) and works in
 * memory. The server never calls an LLM: the AI client looks at the compact
 * structured answers and proposes; the human approves.
 *
 * Read ops: list, clusters, get.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type PgToolContext, dataResponse, err } from "./_shared";
import { registerManageTool } from "./_consolidate";
import { containsNormalized } from "../../src/lib/text-normalize";
import { payeeMatchKey } from "../../src/lib/payees/match-key";
import { loadPayeeOverview, type PayeeOverview } from "../../src/lib/payees/service";
import { unrecognizedGroups, type PayeeCluster, type PayeeGroup } from "../../src/lib/payees/overview";

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

  async function opList(input: { view?: "all" | "unrecognized"; search?: string; sort?: "count" | "total" | "name" | "last_date"; limit?: number }) {
    const o = await overview();
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

  async function opGet(input: { payee?: string; key?: string; cluster_id?: string }) {
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

  registerManageTool(
    server,
    "manage_payees",
    "Review payees (merchants, people, services) across all transactions. list: every payee name with counts, totals, dates, spellings and a type guess (view=unrecognized = not yet in the directory). clusters: groups of spellings that look like one counterparty (Epicentr / Епіцентр / EPITCENTR K10 KYIV 360616), each with confidence, reasons, and needsDecision for private persons (never merged automatically). get: one payee (by any spelling or key) or one cluster with full detail. Matching ignores letter case, apostrophes, Latin/Cyrillic transliteration and card-terminal noise.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("list"),
        view: z.enum(["all", "unrecognized"]).optional().describe("all (default) or unrecognized = payees not linked to a directory entity."),
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
      }),
    ]),
    async (input) => {
      try {
        if (input.op === "list") return await opList(input);
        if (input.op === "clusters") return await opClusters(input);
        return await opGet(input);
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    },
  );
}
