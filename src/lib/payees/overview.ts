/**
 * Payee overview (Payee Studio P1): spellings → groups → clusters.
 *
 *  - A GROUP is every spelling with the same `payeeMatchKey` — certainly one
 *    name (`Epicentr`, `Епіцентр`, `EPITCENTR K10 KYIV 360616`).
 *  - A CLUSTER is a set of groups whose keys are only SIMILAR (`Епіцентр К`
 *    vs `Епіцентр`, a one-letter typo), or a single group stored under
 *    several spellings. Each cluster carries a confidence and the reasons it
 *    was formed, in plain words, so a person (or an AI client) can judge it.
 *
 * Private persons and sole proprietors (ФОП) are never paired with merchants:
 * an edge between a person-like and a merchant-like group is not drawn, and
 * any cluster that contains a person is flagged `needsDecision` (never
 * applied by the autopilot).
 *
 * Pure: no DB, no network. Amount totals come from a caller-supplied
 * `convert` (display-currency conversion lives in ./convert.ts).
 */
import { createHash } from "crypto";
import {
  cleanPayeeDisplay,
  coreOfKey,
  guessPayeeType,
  keySimilarity,
  spellingDifferenceReason,
  type TypeGuess,
} from "./match-key";
import { mergeSlices, PAYEE_SOURCES, type AmountSlice, type PayeeScan, type PayeeSource, type SpellingAgg } from "./scan";

export type NamedCount = { id: number; name: string; count: number };

export type PayeeGroup = {
  /** Comparison key (`payeeMatchKey`). Empty string = transactions with no payee. */
  key: string;
  /** Shown name: the most used spelling. */
  name: string;
  /** A tidy canonical-name suggestion (noise stripped, ALL CAPS title-cased). */
  suggestedName: string;
  /** Every spelling with its row count (all sources), most used first. */
  spellings: Array<{ spelling: string; count: number }>;
  /** `transactions` rows. */
  count: number;
  /** Rows across every source table. */
  rows: number;
  sources: Record<PayeeSource, number>;
  firstDate: string | null;
  lastDate: string | null;
  accounts: NamedCount[];
  categories: NamedCount[];
  /** Signed sum of the transactions in the display currency (0 without a converter). */
  total: number;
  /** Raw slices, for callers that convert themselves. */
  slices: AmountSlice[];
  /** Some spelling carried card-terminal noise (codes, city, long numbers). */
  noisy: boolean;
  type: TypeGuess;
  /** Directory entity this group resolves to (P2), if any. */
  entityId: number | null;
  entityName: string | null;
  /** Most recent transactions (when the scan kept samples). */
  samples?: Array<{ date: string; amount: number; currency: string | null; category: string | null }>;
};

export type PayeeCluster = {
  /** Stable id: hash of the member keys. */
  id: string;
  keys: string[];
  /** 0–1. */
  confidence: number;
  /** Why these were put together, in plain words. */
  reasons: string[];
  /** Contains a private person / sole proprietor: a human must decide. */
  needsDecision: boolean;
  decisionReason: string | null;
  suggestedName: string;
  suggestedType: TypeGuess;
  count: number;
  total: number;
  spellingCount: number;
  groups: PayeeGroup[];
};

export type EntityResolver = (spelling: string, key: string) => { id: number; name: string } | null;

export type BuildGroupsOptions = {
  accountNames?: Map<number, string>;
  categoryNames?: Map<number, string>;
  /** Slices → display-currency total. */
  convert?: (slices: AmountSlice[]) => number;
  /** Directory lookup (P2). */
  resolveEntity?: EntityResolver;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function topNamed(m: Map<number, number>, names: Map<number, string> | undefined, limit: number): NamedCount[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id, count]) => ({ id, name: names?.get(id) ?? `#${id}`, count }));
}

const rowsOf = (s: SpellingAgg) => PAYEE_SOURCES.reduce((n, src) => n + s.counts[src], 0);

/** Fold spellings into groups (one per key). Sorted by transactions count, then rows. */
export function buildPayeeGroups(scan: Pick<PayeeScan, "spellings">, opts: BuildGroupsOptions = {}): PayeeGroup[] {
  type Acc = { key: string; spellings: SpellingAgg[] };
  const byKey = new Map<string, Acc>();
  for (const s of scan.spellings.values()) {
    let acc = byKey.get(s.key);
    if (!acc) byKey.set(s.key, (acc = { key: s.key, spellings: [] }));
    acc.spellings.push(s);
  }
  const out: PayeeGroup[] = [];
  for (const acc of byKey.values()) {
    const spellings = [...acc.spellings].sort((a, b) => rowsOf(b) - rowsOf(a) || a.spelling.localeCompare(b.spelling));
    const sources = { transactions: 0, recurring: 0, staged: 0, pending: 0, bank: 0 } as Record<PayeeSource, number>;
    const slices = new Map<string, AmountSlice>();
    const accounts = new Map<number, number>();
    const categories = new Map<number, number>();
    let firstDate: string | null = null;
    let lastDate: string | null = null;
    let noisy = false;
    for (const s of spellings) {
      for (const src of PAYEE_SOURCES) sources[src] += s.counts[src];
      mergeSlices(slices, s.slices);
      for (const [id, n] of s.accounts) accounts.set(id, (accounts.get(id) ?? 0) + n);
      for (const [id, n] of s.categories) categories.set(id, (categories.get(id) ?? 0) + n);
      if (s.firstDate && (firstDate == null || s.firstDate < firstDate)) firstDate = s.firstDate;
      if (s.lastDate && (lastDate == null || s.lastDate > lastDate)) lastDate = s.lastDate;
      if (cleanPayeeDisplay(s.spelling).toLowerCase() !== s.spelling.toLowerCase()) noisy = true;
    }
    const name = spellings[0].spelling;
    const clean = spellings.find((s) => cleanPayeeDisplay(s.spelling).toLowerCase() === s.spelling.toLowerCase() && s.spelling !== s.spelling.toUpperCase());
    const suggestedName = clean ? clean.spelling : cleanPayeeDisplay(name);
    const sliceList = [...slices.values()];
    const entity = opts.resolveEntity ? opts.resolveEntity(name, acc.key) : null;
    const samples = spellings.some((s) => s.samples)
      ? spellings
          .flatMap((s) => s.samples ?? [])
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 3)
          .map((x) => ({ date: x.date, amount: x.amount, currency: x.currency, category: x.categoryId == null ? null : opts.categoryNames?.get(x.categoryId) ?? null }))
      : undefined;
    out.push({
      key: acc.key,
      name,
      suggestedName,
      spellings: spellings.map((s) => ({ spelling: s.spelling, count: rowsOf(s) })),
      count: sources.transactions,
      rows: PAYEE_SOURCES.reduce((n, src) => n + sources[src], 0),
      sources,
      firstDate,
      lastDate,
      accounts: topNamed(accounts, opts.accountNames, 5),
      categories: topNamed(categories, opts.categoryNames, 5),
      total: opts.convert ? round2(opts.convert(sliceList)) : 0,
      slices: sliceList,
      noisy,
      type: guessPayeeType(suggestedName || name),
      entityId: entity?.id ?? null,
      entityName: entity?.name ?? null,
      ...(samples ? { samples } : {}),
    });
  }
  out.sort((a, b) => b.count - a.count || b.rows - a.rows || a.name.localeCompare(b.name));
  return out;
}

// ─── clustering ─────────────────────────────────────────────────────────────

/** Past this many groups in one block only exact-core pairs are compared (keeps it ~linear). */
export const MAX_PAIRWISE_BLOCK = 300;
export const MIN_EDGE_CONFIDENCE = 0.6;

type Edge = { a: number; b: number; confidence: number; reason: string };

/** Score a pair of groups; null when they should not be clustered. */
export function scorePair(a: PayeeGroup, b: PayeeGroup): { confidence: number; reason: string } | null {
  if (!a.key || !b.key) return null;
  if (a.type.isPerson !== b.type.isPerson) return null; // never pair a person with a merchant
  return scoreKeys(a.key, b.key);
}

/**
 * How alike two DIFFERENT matching keys are: same core (one-letter suffix /
 * legal form) 0.9, one continues the other 0.75, small edit distance
 * 0.6–0.88. Null below that. Identical keys are the caller's business.
 */
export function scoreKeys(keyA: string, keyB: string): { confidence: number; reason: string } | null {
  if (!keyA || !keyB) return null;
  const ca = coreOfKey(keyA);
  const cb = coreOfKey(keyB);
  if (ca === cb) return { confidence: 0.9, reason: "same name apart from a one-letter suffix or legal form" };
  const ta = ca.split(" ");
  const tb = cb.split(" ");
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.join(" ").length >= 5 && short.every((t, i) => long[i] === t)) {
    return { confidence: 0.75, reason: "one name continues the other" };
  }
  if (Math.min(ca.length, cb.length) >= 5) {
    const sim = keySimilarity(ca, cb);
    if (sim >= 0.85) {
      const letters = Math.round((1 - sim) * Math.max(ca.length, cb.length));
      return {
        confidence: Math.min(0.88, round2(0.6 + (sim - 0.85) * 2)),
        reason: `spellings differ by ${letters} letter${letters === 1 ? "" : "s"}`,
      };
    }
  }
  return null;
}

/** Clustering only compares groups whose key core starts with the same 4 characters. */
export function blockKeyOf(key: string): string {
  return coreOfKey(key).slice(0, 4);
}

function blockKey(g: PayeeGroup): string {
  return blockKeyOf(g.key);
}

function clusterId(keys: string[]): string {
  return "c_" + createHash("sha256").update([...keys].sort().join("\u0000"), "utf8").digest("hex").slice(0, 12);
}

/**
 * Cluster groups. Returns clusters with two or more groups, plus single
 * groups stored under several spellings. Sorted: needs-decision last,
 * then by transactions count.
 */
export function buildPayeeClusters(groups: readonly PayeeGroup[]): PayeeCluster[] {
  const parent = groups.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const edges: Edge[] = [];

  const blocks = new Map<string, number[]>();
  groups.forEach((g, i) => {
    if (!g.key) return;
    const k = blockKey(g);
    let list = blocks.get(k);
    if (!list) blocks.set(k, (list = []));
    list.push(i);
  });
  for (const members of blocks.values()) {
    if (members.length < 2) continue;
    if (members.length > MAX_PAIRWISE_BLOCK) {
      // Large block: only identical cores pair up.
      const byCore = new Map<string, number[]>();
      for (const i of members) {
        const c = coreOfKey(groups[i].key);
        let l = byCore.get(c);
        if (!l) byCore.set(c, (l = []));
        l.push(i);
      }
      for (const l of byCore.values()) {
        for (let x = 1; x < l.length; x++) {
          const s = scorePair(groups[l[0]], groups[l[x]]);
          if (s) edges.push({ a: l[0], b: l[x], ...s });
        }
      }
      continue;
    }
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const s = scorePair(groups[members[x]], groups[members[y]]);
        if (s && s.confidence >= MIN_EDGE_CONFIDENCE) edges.push({ a: members[x], b: members[y], ...s });
      }
    }
  }
  // Strongest edges first so a component's weakest link is its confidence.
  edges.sort((p, q) => q.confidence - p.confidence);
  const compEdges = new Map<number, Edge[]>();
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[rb] = ra;
    const merged = [...(compEdges.get(ra) ?? []), ...(compEdges.get(rb) ?? []), e];
    compEdges.delete(rb);
    compEdges.set(ra, merged);
  }
  const comps = new Map<number, number[]>();
  groups.forEach((_, i) => {
    const r = find(i);
    let l = comps.get(r);
    if (!l) comps.set(r, (l = []));
    l.push(i);
  });

  const out: PayeeCluster[] = [];
  for (const [root, idxs] of comps) {
    const members = idxs.map((i) => groups[i]).sort((a, b) => b.count - a.count || b.rows - a.rows);
    const spellingCount = members.reduce((n, g) => n + g.spellings.length, 0);
    if (members.length < 2 && spellingCount < 2) continue;
    if (members.every((g) => !g.key)) continue;
    // Already settled: every member resolves to the same directory entity.
    if (members[0].entityId != null && members.every((g) => g.entityId === members[0].entityId)) continue;
    const reasons = new Set<string>();
    let confidence = 0.95;
    for (const g of members) {
      for (const s of g.spellings.slice(1)) reasons.add(`same name: ${spellingDifferenceReason(g.spellings[0].spelling, s.spelling)}`);
    }
    for (const e of compEdges.get(root) ?? []) {
      reasons.add(e.reason);
      confidence = Math.min(confidence, e.confidence);
    }
    const person = members.find((g) => g.type.isPerson);
    const lead = members[0];
    out.push({
      id: clusterId(members.map((g) => g.key)),
      keys: members.map((g) => g.key),
      confidence: round2(confidence),
      reasons: [...reasons],
      needsDecision: Boolean(person),
      decisionReason: person
        ? `Looks like a ${person.type.type === "sole_proprietor" ? "sole proprietor (ФОП)" : "private person"} (${person.type.reason}); people are never merged automatically.`
        : null,
      suggestedName: lead.suggestedName,
      suggestedType: lead.type,
      count: members.reduce((n, g) => n + g.count, 0),
      total: round2(members.reduce((n, g) => n + g.total, 0)),
      spellingCount,
      groups: members,
    });
  }
  out.sort((a, b) => Number(a.needsDecision) - Number(b.needsDecision) || b.count - a.count || b.spellingCount - a.spellingCount);
  return out;
}

/** Groups with no directory entity, most used first. */
export function unrecognizedGroups(groups: readonly PayeeGroup[]): PayeeGroup[] {
  return groups.filter((g) => g.key && g.entityId == null);
}
