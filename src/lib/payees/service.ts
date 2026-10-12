/**
 * Payee Studio entry points shared by the web routes (`/api/payees…`) and the
 * MCP `manage_payees` tool, so both see the same groups, clusters and totals.
 */
import { getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";
import { buildPayeeClusters, buildPayeeGroups, type EntityResolver, type PayeeCluster, type PayeeGroup } from "./overview";
import { loadPayeeNameMaps, scanPayees, type AmountSlice, type PayeeExecutor, type PayeeScan, type PayeeSource } from "./scan";
import { buildPayeeMatcher, loadDirectory, type PayeeEntity, type PayeeMatcher } from "./directory";
import type { PayeeType } from "./match-key";
import { buildSuggestIndex, getCachedSuggestIndex, querySuggestIndex, setCachedSuggestIndex, type PayeeSuggestion } from "./suggest";

/** Slices → display-currency sum, the way the dashboard converts flows. */
export async function makeSliceConverter(
  userId: string,
  currency?: string,
): Promise<{ currency: string; convert: (slices: AmountSlice[]) => number }> {
  const display = currency ?? (await getDisplayCurrency(userId));
  const rateMap = await getRateMap(display, userId);
  return {
    currency: display,
    convert: (slices) => slices.reduce((sum, s) => sum + convertReportingSlice(s, display, rateMap), 0),
  };
}

export type EntitySummary = {
  id: number;
  name: string;
  type: PayeeType;
  aliasCount: number;
  identifierCount: number;
  defaultCategoryId: number | null;
  /** Transactions resolving to the entity, and their display-currency total. */
  count: number;
  total: number;
  lastDate: string | null;
};

export type PayeeOverview = {
  groups: PayeeGroup[];
  clusters: PayeeCluster[];
  entities: EntitySummary[];
  directory: PayeeEntity[];
  matcher: PayeeMatcher;
  currency: string;
  scanned: PayeeScan["scanned"];
  truncated: PayeeSource[];
  undecryptable: number;
};

/** Scan, group and cluster every payee of a user, resolved against the directory. */
export async function loadPayeeOverview(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  currency?: string;
  /** Override the directory lookup (tests). Default: the user's directory. */
  resolveEntity?: EntityResolver;
  /** Keep the N most recent transactions per spelling as examples. */
  samples?: number;
}): Promise<PayeeOverview> {
  const { executor, userId, dek } = opts;
  const scan = await scanPayees({ executor, userId, dek, samplesPerSpelling: opts.samples });
  const names = await loadPayeeNameMaps(executor, userId, dek);
  const { currency, convert } = await makeSliceConverter(userId, opts.currency);
  const directory = dek ? await loadDirectory(executor, userId, dek) : [];
  const matcher = buildPayeeMatcher(directory);
  const resolveEntity: EntityResolver =
    opts.resolveEntity ??
    ((spelling) => {
      const m = matcher.match(spelling);
      return m.kind === "match" ? { id: m.entityId, name: m.name } : null;
    });
  const groups = buildPayeeGroups(scan, {
    accountNames: names.accounts,
    categoryNames: names.categories,
    convert,
    resolveEntity,
  });
  const totals = new Map<number, { count: number; total: number; lastDate: string | null }>();
  for (const g of groups) {
    if (g.entityId == null) continue;
    const t = totals.get(g.entityId) ?? { count: 0, total: 0, lastDate: null };
    t.count += g.count;
    t.total += g.total;
    if (g.lastDate && (t.lastDate == null || g.lastDate > t.lastDate)) t.lastDate = g.lastDate;
    totals.set(g.entityId, t);
  }
  const entities: EntitySummary[] = directory
    .map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      aliasCount: e.aliases.length,
      identifierCount: e.identifiers.length,
      defaultCategoryId: e.defaultCategoryId,
      count: totals.get(e.id)?.count ?? 0,
      total: Math.round((totals.get(e.id)?.total ?? 0) * 100) / 100,
      lastDate: totals.get(e.id)?.lastDate ?? null,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    groups,
    clusters: buildPayeeClusters(groups),
    entities,
    directory,
    matcher,
    currency,
    scanned: scan.scanned,
    truncated: scan.truncated,
    undecryptable: scan.undecryptable,
  };
}

/**
 * Payee suggestions for the payee boxes (P5a). The index is built from the
 * directory + the decrypted per-user transaction cache and kept for a minute
 * (lib/payees/suggest.ts); a cache hit costs no query.
 */
export async function suggestPayees(opts: { executor: PayeeExecutor; userId: string; dek: Buffer | null; q: string; limit?: number }): Promise<PayeeSuggestion[]> {
  let index = getCachedSuggestIndex(opts.userId);
  if (!index) {
    const directory = opts.dek ? await loadDirectory(opts.executor, opts.userId, opts.dek) : [];
    const { getUserTransactions } = await import("@/lib/mcp/user-tx-cache");
    const rows = opts.dek ? await getUserTransactions(opts.userId, opts.dek) : [];
    index = buildSuggestIndex(directory, rows.map((r) => ({ payee: r.payee, date: r.date })));
    setCachedSuggestIndex(opts.userId, index);
  }
  return querySuggestIndex(index, opts.q, opts.limit ?? 10);
}
