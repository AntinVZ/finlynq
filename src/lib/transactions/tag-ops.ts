/**
 * Tag management over a user's transactions: list every tag, and plan / run
 * rename, merge and delete. Shared by `GET`/`POST /api/tags` (Settings → Tags)
 * and the MCP `manage_tags` tool, so both report the same counts and write
 * the same way.
 *
 * Tags live inside the encrypted comma-separated `transactions.tags` text (no
 * tags table), so everything here is: read the user's tagged rows in batches,
 * decrypt, work on the plaintext with `lib/tags.ts`, and write changes through
 * `rewriteTransactionTags` (user-scoped, `updated_at` bumped, batched).
 *
 * Tag identity is `tagKey` (`normalizeForMatch`): `Acme`, `acme `
 * and `ACME` are one tag with three spellings.
 */
import { sql, type SQL } from "drizzle-orm";
import { decryptField } from "@/lib/crypto/envelope";
import { normalizeDbRows } from "@/lib/db-utils";
import { parseTags, removeTags, replaceTags, tagKey, toTagList } from "@/lib/tags";
import type { BusinessFilter } from "@/lib/reports/business-filter";
import { businessFilterCondition } from "@/lib/reports/business-filter-sql";
import { rewriteTransactionTags, type TagRewriteResult, type TagWriteExecutor } from "./rewrite-tags";

/** Rows read per page while scanning. */
export const TAG_SCAN_BATCH = 2_000;
/** Scan bound: past this many tagged rows the scan stops and says `truncated`. */
export const TAG_SCAN_MAX = 100_000;
/** Most rows one rename / merge / delete may change (same ceiling as the bulk tools). */
export const TAG_OP_MAX_ROWS = 10_000;

export type TaggedRow = {
  id: number;
  date: string;
  /** Decrypted tag text. */
  tags: string;
  amount: number;
  currency: string | null;
  reportingAmount: number | null;
  reportingCurrency: string | null;
};

export type TagScan = { rows: TaggedRow[]; scanned: number; truncated: boolean; undecryptable: number };

/**
 * Read the user's rows that have a non-empty `tags` value, newest id last,
 * page by page, and decrypt their tags. Rows whose tags can't be decrypted
 * are counted and left out (never matched, never rewritten).
 */
export async function scanTaggedRows(opts: {
  executor: TagWriteExecutor;
  userId: string;
  dek: Buffer | null;
  business?: BusinessFilter;
  maxScan?: number;
  batchSize?: number;
}): Promise<TagScan> {
  const { executor, userId, dek } = opts;
  const maxScan = opts.maxScan ?? TAG_SCAN_MAX;
  const batchSize = opts.batchSize ?? TAG_SCAN_BATCH;
  const biz = businessFilterCondition(opts.business ?? "all", sql`is_business`);
  const out: TagScan = { rows: [], scanned: 0, truncated: false, undecryptable: 0 };
  let lastId = 0;
  for (;;) {
    const size = Math.min(batchSize, maxScan - out.scanned);
    if (size <= 0) {
      // Out of budget: truncated only if something is left unread.
      const probe = normalizeDbRows(
        await executor.execute(tagPage(userId, biz, lastId, 1)),
      );
      out.truncated = probe.length > 0;
      break;
    }
    const page = normalizeDbRows<Record<string, unknown>>(
      await executor.execute(tagPage(userId, biz, lastId, size)),
    );
    out.scanned += page.length;
    for (const r of page) {
      lastId = Math.max(lastId, Number(r.id));
      const stored = r.tags == null ? "" : String(r.tags);
      let plain: string;
      try {
        plain = dek ? (decryptField(dek, stored) ?? "") : stored;
      } catch {
        out.undecryptable++;
        continue;
      }
      if (!dek && stored.startsWith("v1:")) {
        out.undecryptable++;
        continue;
      }
      out.rows.push({
        id: Number(r.id),
        date: String(r.date ?? ""),
        tags: plain,
        amount: Number(r.amount ?? 0),
        currency: r.currency == null ? null : String(r.currency),
        reportingAmount: r.reporting_amount == null ? null : Number(r.reporting_amount),
        reportingCurrency: r.reporting_currency == null ? null : String(r.reporting_currency),
      });
    }
    if (page.length < size) break;
  }
  return out;
}

function tagPage(userId: string, biz: SQL | null, afterId: number, size: number): SQL {
  return sql`
    SELECT id, date, tags, amount, currency, reporting_amount, reporting_currency
    FROM transactions
    WHERE user_id = ${userId} AND tags IS NOT NULL AND tags <> ''
      ${biz ? sql`AND ${biz}` : sql``}
      AND id > ${afterId}
    ORDER BY id
    LIMIT ${size}
  `;
}

// ─── list ──────────────────────────────────────────────────────────────────

export type TagSlice = { currency: string | null; reportingCurrency: string | null; totalAmount: number; totalReporting: number | null };

export type TagSummary = {
  /** Shown spelling: the most used one; ties go to the one seen first. */
  tag: string;
  /** Normalized identity (`tagKey`). */
  key: string;
  /** Transactions carrying the tag. */
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Every spelling seen with its transaction count, most used first. */
  spellings: Array<{ spelling: string; count: number }>;
  /** True when the tag is stored with more than one spelling. */
  hasVariants: boolean;
  /** Per (currency, reporting currency) amount sums — for the caller to convert. */
  slices: TagSlice[];
};

/** Group scanned rows by tag. Sorted by count (desc), then tag. */
export function summarizeTags(rows: readonly TaggedRow[]): TagSummary[] {
  type Acc = {
    key: string;
    count: number;
    firstDate: string | null;
    lastDate: string | null;
    spellings: Map<string, { count: number; order: number }>;
    slices: Map<string, TagSlice>;
  };
  const byKey = new Map<string, Acc>();
  let order = 0;
  for (const row of rows) {
    // Raw split (not parseTags) so every spelling on the row is seen; a row
    // counts once per tag and once per spelling.
    const spellingsByKey = new Map<string, Set<string>>();
    for (const part of row.tags.split(",")) {
      const spelling = part.trim();
      const key = spelling ? tagKey(spelling) : "";
      if (!key) continue;
      let set = spellingsByKey.get(key);
      if (!set) spellingsByKey.set(key, (set = new Set()));
      set.add(spelling);
    }
    for (const [key, spellings] of spellingsByKey) {
      let acc = byKey.get(key);
      if (!acc) {
        acc = { key, count: 0, firstDate: null, lastDate: null, spellings: new Map(), slices: new Map() };
        byKey.set(key, acc);
      }
      for (const spelling of spellings) {
        const sp = acc.spellings.get(spelling);
        if (sp) sp.count++;
        else acc.spellings.set(spelling, { count: 1, order: order++ });
      }
      acc.count++;
      if (row.date) {
        if (acc.firstDate == null || row.date < acc.firstDate) acc.firstDate = row.date;
        if (acc.lastDate == null || row.date > acc.lastDate) acc.lastDate = row.date;
      }
      const sliceKey = `${row.currency ?? ""}|${row.reportingCurrency ?? ""}`;
      let slice = acc.slices.get(sliceKey);
      if (!slice) {
        slice = { currency: row.currency, reportingCurrency: row.reportingCurrency, totalAmount: 0, totalReporting: 0 };
        acc.slices.set(sliceKey, slice);
      }
      slice.totalAmount += row.amount;
      // One row without a stored reporting amount makes the slice fall back
      // to converting `totalAmount` (convertReportingSlice's rule).
      if (slice.totalReporting != null) {
        slice.totalReporting = row.reportingAmount == null ? null : slice.totalReporting + row.reportingAmount;
      }
    }
  }
  const out: TagSummary[] = [];
  for (const acc of byKey.values()) {
    const spellings = [...acc.spellings.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].order - b[1].order)
      .map(([spelling, v]) => ({ spelling, count: v.count }));
    out.push({
      tag: spellings[0].spelling,
      key: acc.key,
      count: acc.count,
      firstDate: acc.firstDate,
      lastDate: acc.lastDate,
      spellings,
      hasVariants: spellings.length > 1,
      slices: [...acc.slices.values()],
    });
  }
  out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return out;
}

// ─── rename / merge / delete ──────────────────────────────────────────────

export type TagOp =
  | { op: "rename"; from: string; to: string }
  | { op: "merge"; from: readonly string[]; to: string }
  | { op: "delete"; tags: readonly string[] };

/** Validate and normalize an op; returns an error message for a bad one. */
export function normalizeTagOp(op: TagOp): { ok: true; op: TagOp } | { ok: false; error: string } {
  if (op.op === "delete") {
    const tags = toTagList(op.tags);
    if (tags.length === 0) return { ok: false, error: "Name at least one tag to delete." };
    return { ok: true, op: { op: "delete", tags } };
  }
  const to = toTagList(op.to);
  if (to.length !== 1) return { ok: false, error: "The new tag name must be one non-empty tag without commas." };
  const from = toTagList(op.op === "rename" ? [op.from] : op.from);
  if (from.length === 0) return { ok: false, error: op.op === "rename" ? "Name the tag to rename." : "Name at least one tag to merge." };
  if (op.op === "rename") {
    if (from.length !== 1) return { ok: false, error: "Rename takes one tag; use merge for several." };
    return { ok: true, op: { op: "rename", from: from[0], to: to[0] } };
  }
  return { ok: true, op: { op: "merge", from, to: to[0] } };
}

/** The per-row edit an op applies (plaintext tags in, out). */
export function tagOpTransform(op: TagOp): (tags: string) => string {
  if (op.op === "delete") return (t) => removeTags(t, op.tags);
  const from = op.op === "rename" ? [op.from] : op.from;
  return (t) => replaceTags(t, from, op.to);
}

export type TagOpPlan = {
  /** Rows the op would change. */
  ids: number[];
  affected: number;
  /** For rename / merge: the target tag already exists on other rows (so this merges). */
  targetExists: boolean;
  /** Rows already carrying the target, before the op. */
  targetCount: number;
  /** Over TAG_OP_MAX_ROWS, or the scan stopped early: not runnable. */
  tooLarge: boolean;
  truncated: boolean;
};

/** Work out which rows an op changes, from a scan. Pure. */
export function planTagOp(op: TagOp, scan: TagScan): TagOpPlan {
  const transform = tagOpTransform(op);
  const ids: number[] = [];
  // Renaming onto a tag that already exists merges the two. A target that is
  // itself one of the sources (e.g. "acme " → "Acme") is only a
  // respelling, so it never counts as existing.
  const targetKey = op.op === "delete" ? null : tagKey(op.to);
  const sourceKeys = new Set(op.op === "delete" ? [] : (op.op === "rename" ? [op.from] : op.from).map(tagKey));
  const checkTarget = targetKey != null && !sourceKeys.has(targetKey);
  let targetCount = 0;
  for (const row of scan.rows) {
    if (checkTarget && parseTags(row.tags).some((t) => tagKey(t) === targetKey)) targetCount++;
    if (transform(row.tags) !== row.tags) ids.push(row.id);
  }
  return {
    ids,
    affected: ids.length,
    targetExists: targetCount > 0,
    targetCount,
    tooLarge: ids.length > TAG_OP_MAX_ROWS,
    truncated: scan.truncated,
  };
}

/** Apply an op to the planned rows. Caller invalidates the tx cache when `changed > 0`. */
export async function runTagOp(opts: {
  executor: TagWriteExecutor;
  userId: string;
  dek: Buffer | null;
  op: TagOp;
  ids: readonly number[];
}): Promise<TagRewriteResult> {
  return rewriteTransactionTags({
    executor: opts.executor,
    userId: opts.userId,
    dek: opts.dek,
    ids: opts.ids,
    transform: tagOpTransform(opts.op),
  });
}
