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
import { computeMerchantAnalytics, type Period } from "./merchant-analytics";
import { computeLookalikes, describeRejections, loadRejections, rejectionPredicate } from "./lookalikes";
import { getPayeeSettings, vocabularyOf } from "./settings";
import type { PayeeVocabulary } from "./type-words";
import { entityMerchantTypeHints, loadMerchantTypes, type EntityTypeHint, type MerchantType, type MerchantTypeRef } from "./merchant-types";
import { listSuspicious, type SuspiciousEntry } from "./suspicious";
import { describeOwnAccount, loadOwnMatcher, type OwnMatcher } from "./own-accounts";
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
  /** P6.1: exact / contains alias spellings (not the canonical name, not regexes), for the web picker's search. */
  aliasNames: string[];
  identifierCount: number;
  defaultCategoryId: number | null;
  /** P5c: has a website / a logo (the logo itself is served by /api/payees/[id]/logo). */
  website: string | null;
  hasLogo: boolean;
  /** P6 (B26): the entry's merchant type, and a suggestion for an untyped entry (never applied by itself). */
  merchantType: (MerchantTypeRef & { id: number }) | null;
  merchantTypeHint: (MerchantTypeRef & { reason: string; strength: EntityTypeHint["strength"]; field: EntityTypeHint["field"]; matched: string }) | null;
  /** P6.2 (B29): the name and the aliases suggest different types — no automatic assignment. */
  merchantTypeMixed: string | null;
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
  /** P6: the user's type words and bank-operation patterns. */
  vocab: PayeeVocabulary;
  /** P6: the merchant-type dictionary (the virtual starting set when the user has none). */
  merchantTypes: MerchantType[];
  /** P6.2 (76): the user's own accounts / cards. */
  own: OwnMatcher;
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
  const vocab = vocabularyOf(await getPayeeSettings(executor, userId));
  const merchantTypes = await loadMerchantTypes(executor, userId);
  const own = await loadOwnMatcher(executor, userId, dek);
  const directoryById = new Map(directory.map((e) => [e.id, e]));
  const typeById = new Map(merchantTypes.filter((t) => t.id != null).map((t) => [t.id!, t]));
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
    vocab,
    own,
    ownOfEntity: (id) => {
      const e = directoryById.get(id);
      const hit = e ? own.forEntity(e) : null;
      return hit ? describeOwnAccount(hit) : null;
    },
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
      aliasNames: e.aliases.filter((a) => a.mode !== "regex" && a.source !== "canonical").map((a) => a.pattern),
      identifierCount: e.identifiers.length,
      defaultCategoryId: e.defaultCategoryId,
      website: e.website,
      hasLogo: e.logo != null,
      merchantType: (() => {
        const t = e.merchantTypeId == null ? undefined : typeById.get(e.merchantTypeId);
        return t ? { id: t.id!, group: t.group, name: t.name, code: t.code ?? null } : null;
      })(),
      ...(() => {
        if (e.merchantTypeId != null) return { merchantTypeHint: null, merchantTypeMixed: null };
        const h = entityMerchantTypeHints(e, merchantTypes, { vocab });
        return {
          merchantTypeHint: h.hint ? { group: h.hint.group, name: h.hint.name, reason: h.hint.reason, strength: h.hint.strength, field: h.hint.field, matched: h.hint.matched } : null,
          merchantTypeMixed: h.mixedReason,
        };
      })(),
      count: totals.get(e.id)?.count ?? 0,
      total: Math.round((totals.get(e.id)?.total ?? 0) * 100) / 100,
      lastDate: totals.get(e.id)?.lastDate ?? null,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    groups,
    clusters: buildPayeeClusters(groups, { vocab }),
    entities,
    directory,
    matcher,
    currency,
    scanned: scan.scanned,
    truncated: scan.truncated,
    undecryptable: scan.undecryptable,
    vocab,
    merchantTypes,
    own,
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

/** Look-alikes against the directory (P5b), with remembered "different payee" answers filtered out. Read only. */
export async function loadLookalikes(opts: { executor: PayeeExecutor; userId: string; dek: Buffer | null; overview: PayeeOverview; limit?: number }) {
  const { executor, userId, dek, overview } = opts;
  const rows = dek ? await loadRejections(executor, userId) : [];
  const report = computeLookalikes(overview.groups, overview.directory, {
    rejected: dek && rows.length ? rejectionPredicate(dek, rows) : undefined,
    limit: opts.limit,
    vocab: overview.vocab,
  });
  // P6.1: lists show the entry's merchant type next to its name.
  const typeOf = new Map(overview.entities.map((e) => [e.id, e.merchantType ? { group: e.merchantType.group, name: e.merchantType.name } : null]));
  const candidates = report.candidates.map((c) => ({ ...c, entity: { ...c.entity, merchantType: typeOf.get(c.entity.id) ?? null } }));
  return { ...report, candidates, rejections: dek ? describeRejections(rows, dek, overview.groups, overview.directory) : [] };
}

/** The eight merchant analyses (P5d) in the display currency. Read only. */
export async function loadMerchantAnalytics(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  period?: Period | null;
  period1?: Period;
  period2?: Period;
  entityId?: number;
  name?: string;
  limit?: number;
  asOf?: string;
  currency?: string;
}) {
  const { executor, userId, dek } = opts;
  const display = opts.currency ?? (await getDisplayCurrency(userId));
  const vocab = vocabularyOf(await getPayeeSettings(executor, userId));
  const [rateMap, directory, names, own] = await Promise.all([
    getRateMap(display, userId),
    dek ? loadDirectory(executor, userId, dek) : Promise.resolve([]),
    loadPayeeNameMaps(executor, userId, dek),
    loadOwnMatcher(executor, userId, dek),
  ]);
  return computeMerchantAnalytics({
    executor,
    userId,
    dek,
    matcher: buildPayeeMatcher(directory),
    currency: display,
    rateMap,
    period: opts.period,
    period1: opts.period1,
    period2: opts.period2,
    entityId: opts.entityId,
    name: opts.name,
    limit: opts.limit,
    asOf: opts.asOf,
    categoryNames: names.categories,
    vocab,
    own,
  });
}

/** P6.2 (83): directory entries with a short / meaningless name, with their rows and spellings. Read only. */
export function suspiciousOf(o: PayeeOverview, opts: { includeReviewed?: boolean } = {}): SuspiciousEntry[] {
  const counts = new Map(o.entities.map((e) => [e.id, e.count]));
  return listSuspicious(
    o.directory,
    (id) => ({
      count: counts.get(id) ?? 0,
      spellings: o.groups
        .filter((g) => g.entityId === id)
        .flatMap((g) => g.spellings.map((s) => ({ spelling: s.spelling, count: s.count })))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    }),
    { includeReviewed: opts.includeReviewed, vocab: o.vocab },
  );
}
