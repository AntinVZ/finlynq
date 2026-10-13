/**
 * Bulk registry fill (Payee Studio P6.2, item 82 / B28): build the payee
 * directory from hundreds of counterparties in minutes instead of one by one.
 *
 * Flow (web and MCP): review → propose → ONE confirmation.
 *   1. `buildBulkCandidates` lists every unrecognized counterparty as one row:
 *      a look-alike cluster at or above the threshold (default 0.9) without
 *      "needs decision", or a single payee group not in any cluster. Each row
 *      carries a canonical name (the most used mixed-case spelling), a
 *      merchant-type SUGGESTION, every spelling and the row count. No brand
 *      (only type words), the bank's own rows and transfers between own
 *      accounts are left out. Private persons and sole proprietors are NEVER
 *      in the table: they go to a separate "people" list for a manual
 *      decision one by one.
 *   2. The person unticks rows, edits names and confirms types in the table.
 *   3. `commitBulkRegistry` creates every chosen row as a directory entry —
 *      its spellings as exact aliases, the merchant type ONLY when the person
 *      confirmed it — in ONE payee batch (30-day undo), with ONE preview
 *      (`dryRun`). Stored payees are NOT renamed here: the result says how
 *      many rows a later Apply (with its own preview) would rewrite.
 *
 * Size: at most BULK_MAX entries per confirmation (a plain-language error
 * above it: confirm the rest as a second set). 150 entries take about 2 s.
 */
import { createHash } from "crypto";
import { canonicalSpelling, guessPayeeType, payeeMatchKey } from "./match-key";
import { executePayeeOp, PayeeDirectoryError, type PayeeOpResult, type SingleOp } from "./ops";
import { buildPayeeMatcher, loadDirectory } from "./directory";
import { planPayeeApply } from "./apply";
import { suggestMerchantType, type MerchantTypeRef } from "./merchant-types";
import type { PayeeGroup } from "./overview";
import type { PayeeOverview } from "./service";
import type { BatchActor } from "./batches";
import type { PayeeExecutor } from "./scan";
import { st } from "@/lib/i18n/current";

export const BULK_DEFAULT_THRESHOLD = 0.9;
/** Most entries one confirmation may create (one batch). */
export const BULK_MAX = 300;

export type BulkRow = {
  /** Stable while the data is unchanged: the cluster id, or `g_` + a hash of the group key. */
  rowId: string;
  name: string;
  /** A suggestion only; never stored unless the person confirms it. */
  merchantTypeHint: (MerchantTypeRef & { reason: string }) | null;
  spellings: Array<{ spelling: string; count: number }>;
  /** Rows across every source table. */
  rows: number;
  /** Transactions only. */
  transactions: number;
  confidence: number;
  /** "cluster" = several look-alike groups; "group" = one name, maybe several spellings. */
  source: "cluster" | "group";
  /** Payee group keys of the row (for a manual decision on the "Особи" tab). */
  keys: string[];
  /** People list only: why it is a person / ФОП. */
  personReason?: string;
};

export type BulkCandidates = {
  threshold: number;
  rows: BulkRow[];
  people: BulkRow[];
  /** Clusters left out: below the threshold, or joining different brands (needs a decision). */
  left: { belowThreshold: number; needsDecision: number };
};

const groupRowId = (key: string) => "g_" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);

/** Not a merchant: empty, only type words, the bank's own rows, a transfer between own accounts, or already in the directory. */
function eligible(g: PayeeGroup): boolean {
  return Boolean(g.key) && g.entityId == null && !g.brand.typeOnly && g.bankOperation == null && !g.ownAccount;
}

/** The counterparties that can go into the directory in one go. Read only. */
export function buildBulkCandidates(o: Pick<PayeeOverview, "groups" | "clusters" | "merchantTypes" | "vocab">, opts: { threshold?: number } = {}): BulkCandidates {
  const threshold = Math.min(1, Math.max(0, opts.threshold ?? BULK_DEFAULT_THRESHOLD));
  const rows: BulkRow[] = [];
  const people: BulkRow[] = [];
  const left = { belowThreshold: 0, needsDecision: 0 };
  const used = new Set<string>();
  const make = (groups: PayeeGroup[], rowId: string, confidence: number, source: BulkRow["source"]): BulkRow => {
    const spellings = groups.flatMap((g) => g.spellings.map((s) => ({ spelling: s.spelling, count: s.count }))).sort((a, b) => b.count - a.count);
    const name = canonicalSpelling(spellings) || groups[0].suggestedName;
    const hint = suggestMerchantType([name, ...spellings.map((s) => s.spelling)], o.merchantTypes, { vocab: o.vocab });
    return {
      rowId,
      keys: groups.map((g) => g.key),
      name,
      merchantTypeHint: hint ? { group: hint.type.group, name: hint.type.name, reason: hint.reason } : null,
      spellings,
      rows: groups.reduce((n, g) => n + g.rows, 0),
      transactions: groups.reduce((n, g) => n + g.count, 0),
      confidence,
      source,
    };
  };
  for (const c of o.clusters) {
    if (!c.groups.every(eligible)) continue;
    for (const g of c.groups) used.add(g.key);
    const person = c.groups.find((g) => g.type.isPerson);
    if (person) {
      people.push({ ...make(c.groups, c.id, c.confidence, "cluster"), personReason: person.type.reason });
      continue;
    }
    if (c.needsDecision) {
      left.needsDecision++;
      continue;
    }
    if (c.confidence < threshold) {
      left.belowThreshold++;
      continue;
    }
    rows.push(make(c.groups, c.id, c.confidence, "cluster"));
  }
  for (const g of o.groups) {
    if (!eligible(g) || used.has(g.key)) continue;
    const row = make([g], groupRowId(g.key), 1, "group");
    if (g.type.isPerson) people.push({ ...row, personReason: g.type.reason });
    else rows.push(row);
  }
  const order = (a: BulkRow, b: BulkRow) => b.rows - a.rows || a.name.localeCompare(b.name);
  return { threshold, rows: rows.sort(order), people: people.sort(order), left };
}

export type BulkItem = {
  rowId: string;
  /** Edited name (default: the row's name). */
  name?: string;
  /** The type the person CONFIRMED in the table (id, "Група → Позиція" or { group, name }); absent / null = no type. */
  merchantType?: number | string | MerchantTypeRef | null;
};

export type BulkResult = PayeeOpResult & {
  bulk: {
    /** Entries created (or, in a preview, to be created). */
    entities: Array<{ rowId: string; name: string; aliases: number; merchantType: string | null }>;
    created: number;
    /** Ids of the created entries (empty in a preview): a later Apply renames their rows. */
    createdIds: number[];
    /** Stored rows a later Apply would rename to the new canonical names. */
    pendingRows: number;
    pendingByTable: PayeeOpResult["rows"]["byTable"];
  };
};

/**
 * Create the chosen rows as directory entries in ONE batch (preview with
 * `dryRun`). Rows are found again by `rowId` in a fresh candidate list (any
 * threshold), so only the current spellings are used; a row that is gone,
 * or a person, fails the whole set with a plain message.
 */
export async function commitBulkRegistry(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer;
  overview: PayeeOverview;
  items: BulkItem[];
  actor: BatchActor;
  dryRun?: boolean;
}): Promise<BulkResult> {
  const { executor, userId, dek, overview, items } = opts;
  if (!items.length) throw new PayeeDirectoryError(st("srv.bulk.pickRow"));
  if (items.length > BULK_MAX) {
    throw new PayeeDirectoryError(st("srv.bulk.tooLarge", { n: items.length, max: BULK_MAX }), "too_large");
  }
  const all = buildBulkCandidates(overview, { threshold: 0 });
  const byId = new Map(all.rows.map((r) => [r.rowId, r]));
  const personIds = new Set(all.people.map((r) => r.rowId));
  const seen = new Set<string>();
  const ops: SingleOp[] = [];
  const labels: string[] = [];
  const planned: BulkResult["bulk"]["entities"] = [];
  const missing: string[] = [];
  for (const it of items) {
    if (seen.has(it.rowId)) continue;
    seen.add(it.rowId);
    if (personIds.has(it.rowId)) throw new PayeeDirectoryError(st("srv.bulk.peopleExcluded"), "person");
    const row = byId.get(it.rowId);
    if (!row) {
      missing.push(it.rowId);
      continue;
    }
    const name = (it.name ?? row.name).replace(/\s+/g, " ").trim();
    if (guessPayeeType(name).isPerson) throw new PayeeDirectoryError(st("srv.bulk.looksPerson", { name }), "person");
    const nameKey = payeeMatchKey(name);
    const aliases = row.spellings.filter((s) => payeeMatchKey(s.spelling) !== nameKey || s.spelling !== name).map((s) => ({ pattern: s.spelling, mode: "exact" as const }));
    const merchantType = it.merchantType ?? null;
    ops.push({ op: "create", name, aliases, ...(merchantType != null ? { merchantType } : {}), apply: false });
    labels.push(`«${name}»`);
    planned.push({ rowId: row.rowId, name, aliases: aliases.length, merchantType: typeof merchantType === "string" ? merchantType : merchantType == null ? null : typeof merchantType === "number" ? `#${merchantType}` : `${merchantType.group} → ${merchantType.name}` });
  }
  if (missing.length) {
    throw new PayeeDirectoryError(st("srv.bulk.rowsGone", { n: missing.length }), "not_found");
  }
  const before = new Set(overview.directory.map((e) => e.id));
  let createdIds: number[] = [];
  const pending = { rows: 0, byTable: { transactions: 0, recurring: 0, staged: 0 } as PayeeOpResult["rows"]["byTable"] };
  // ONE batch; each create step sees the entries the previous steps made.
  const result = await executePayeeOp({
    executor,
    userId,
    dek,
    actor: opts.actor,
    dryRun: opts.dryRun,
    op: { op: "bulk", kind: "bulk_registry", ops, labels, aliasSource: "bulk" },
    onBatch: async (tx) => {
      const dir = await loadDirectory(tx, userId, dek);
      const created = new Set(dir.filter((e) => !before.has(e.id)).map((e) => e.id));
      if (!created.size) return;
      createdIds = [...created].sort((a, b) => a - b);
      const plan = await planPayeeApply({ executor: tx, userId, dek, matcher: buildPayeeMatcher(dir), entityIds: created });
      pending.rows = plan.total;
      pending.byTable = plan.byTable;
    },
  });
  return { ...result, bulk: { entities: planned, created: planned.length, createdIds: opts.dryRun ? [] : createdIds, pendingRows: pending.rows, pendingByTable: pending.byTable } };
}
