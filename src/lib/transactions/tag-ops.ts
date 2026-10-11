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
import { formatTags, parseTags, removeTags, replaceTags, tagKey, toTagList } from "@/lib/tags";
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
  /** `transactions.is_business`; NULL counts as personal (same as the reports). */
  isBusiness?: boolean;
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
        isBusiness: Number(r.is_business ?? 0) === 1 || r.is_business === true,
      });
    }
    if (page.length < size) break;
  }
  return out;
}

function tagPage(userId: string, biz: SQL | null, afterId: number, size: number): SQL {
  return sql`
    SELECT id, date, tags, amount, currency, reporting_amount, reporting_currency, is_business
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
  /** Of `count`: transactions flagged business / not (NULL = personal). */
  businessCount: number;
  personalCount: number;
  /** Per (currency, reporting currency) amount sums — for the caller to convert. */
  slices: TagSlice[];
};

/** Add a row's amount to its (currency, reporting currency) slice. */
function addToSlices(slices: Map<string, TagSlice>, row: TaggedRow): void {
  const sliceKey = `${row.currency ?? ""}|${row.reportingCurrency ?? ""}`;
  let slice = slices.get(sliceKey);
  if (!slice) {
    slice = { currency: row.currency, reportingCurrency: row.reportingCurrency, totalAmount: 0, totalReporting: 0 };
    slices.set(sliceKey, slice);
  }
  slice.totalAmount += row.amount;
  // One row without a stored reporting amount makes the slice fall back
  // to converting `totalAmount` (convertReportingSlice's rule).
  if (slice.totalReporting != null) {
    slice.totalReporting = row.reportingAmount == null ? null : slice.totalReporting + row.reportingAmount;
  }
}

/** Group scanned rows by tag. Sorted by count (desc), then tag. */
export function summarizeTags(rows: readonly TaggedRow[]): TagSummary[] {
  type Acc = {
    key: string;
    count: number;
    businessCount: number;
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
        acc = { key, count: 0, businessCount: 0, firstDate: null, lastDate: null, spellings: new Map(), slices: new Map() };
        byKey.set(key, acc);
      }
      for (const spelling of spellings) {
        const sp = acc.spellings.get(spelling);
        if (sp) sp.count++;
        else acc.spellings.set(spelling, { count: 1, order: order++ });
      }
      acc.count++;
      if (row.isBusiness) acc.businessCount++;
      if (row.date) {
        if (acc.firstDate == null || row.date < acc.firstDate) acc.firstDate = row.date;
        if (acc.lastDate == null || row.date > acc.lastDate) acc.lastDate = row.date;
      }
      addToSlices(acc.slices, row);
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
      businessCount: acc.businessCount,
      personalCount: acc.count - acc.businessCount,
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
  return runTagTransform({ ...opts, transform: tagOpTransform(opts.op) });
}

/** Apply any per-row tag transform to the planned rows (through the shared batch writer). */
export async function runTagTransform(opts: {
  executor: TagWriteExecutor;
  userId: string;
  dek: Buffer | null;
  transform: (tags: string) => string;
  ids: readonly number[];
}): Promise<TagRewriteResult> {
  return rewriteTransactionTags({
    executor: opts.executor,
    userId: opts.userId,
    dek: opts.dek,
    ids: opts.ids,
    transform: opts.transform,
  });
}

// ─── hierarchy: tags with "/" (e.g. `команда/Іваненко`) ───────────────────────
//
// A tag containing "/" is read as a path; every prefix is a tree node. The
// stored tags are untouched — the tree is only a view, plus a prefix rename
// that rewrites a whole branch at once.

/** Path segments of a tag: split on "/", trimmed, empties dropped. */
export function tagPathSegments(tag: string): string[] {
  return tag.split("/").map((s) => s.trim()).filter(Boolean);
}

/** Identity of a tag path: each segment's `tagKey`, joined by "/". */
export function tagPathKey(tag: string): string {
  return tagPathSegments(tag).map(tagKey).filter(Boolean).join("/");
}

export type TagTreeNode = {
  /** Display path (most used spelling of this prefix). */
  path: string;
  /** `tagPathKey` of the path. */
  key: string;
  /** Last segment of `path`. */
  name: string;
  depth: number;
  parentKey: string | null;
  /** The path itself is used as a tag (not only as a prefix of others). */
  isTag: boolean;
  /** Distinct transactions carrying this tag or any tag under it — a row with
   *  `a/b` and `a/c` counts once for `a`. */
  count: number;
  /** Transactions carrying exactly this tag. */
  ownCount: number;
  businessCount: number;
  personalCount: number;
  /** Distinct tags at or under this node. */
  tagCount: number;
  childCount: number;
  slices: TagSlice[];
};

/**
 * Build the "/" tree with per-node rollups counted over DISTINCT transactions
 * (no double counting when a row carries several tags of one branch). Flat
 * list sorted by path; tags without "/" are depth-0 leaves.
 */
export function buildTagTree(rows: readonly TaggedRow[]): TagTreeNode[] {
  type Acc = {
    key: string;
    depth: number;
    parentKey: string | null;
    spellings: Map<string, number>;
    count: number;
    ownCount: number;
    businessCount: number;
    tags: Set<string>;
    children: Set<string>;
    slices: Map<string, TagSlice>;
  };
  const nodes = new Map<string, Acc>();
  const node = (key: string, depth: number, parentKey: string | null): Acc => {
    let n = nodes.get(key);
    if (!n) {
      n = { key, depth, parentKey, spellings: new Map(), count: 0, ownCount: 0, businessCount: 0, tags: new Set(), children: new Set(), slices: new Map() };
      nodes.set(key, n);
    }
    return n;
  };
  for (const row of rows) {
    const touched = new Set<string>();
    const own = new Set<string>();
    for (const tag of parseTags(row.tags)) {
      const segs = tagPathSegments(tag);
      const keys = segs.map(tagKey);
      if (keys.some((k) => !k)) continue;
      for (let i = 0; i < segs.length; i++) {
        const key = keys.slice(0, i + 1).join("/");
        const parentKey = i === 0 ? null : keys.slice(0, i).join("/");
        const n = node(key, i, parentKey);
        if (parentKey) nodes.get(parentKey)!.children.add(key);
        const spelling = segs.slice(0, i + 1).join("/");
        n.spellings.set(spelling, (n.spellings.get(spelling) ?? 0) + 1);
        n.tags.add(keys.join("/"));
        touched.add(key);
      }
      own.add(keys.join("/"));
    }
    for (const key of touched) {
      const n = nodes.get(key)!;
      n.count++;
      if (row.isBusiness) n.businessCount++;
      addToSlices(n.slices, row);
    }
    for (const key of own) nodes.get(key)!.ownCount++;
  }
  const out: TagTreeNode[] = [];
  for (const n of nodes.values()) {
    const path = [...n.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const segs = path.split("/");
    out.push({
      path,
      key: n.key,
      name: segs[segs.length - 1],
      depth: n.depth,
      parentKey: n.parentKey,
      isTag: n.ownCount > 0,
      count: n.count,
      ownCount: n.ownCount,
      businessCount: n.businessCount,
      personalCount: n.count - n.businessCount,
      tagCount: n.tags.size,
      childCount: n.children.size,
      slices: [...n.slices.values()],
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Per-row transform renaming a tag path prefix: `from` itself becomes `to`,
 * and `from/rest` becomes `to/rest`. Tags outside the branch are untouched;
 * if a renamed tag lands on one the row already has, the first one wins
 * (same rule as `replaceTags`).
 */
export function renamePrefixTransform(from: string, to: string): (tags: string) => string {
  const fromKey = tagPathKey(from);
  const fromDepth = tagPathSegments(from).length;
  const target = tagPathSegments(to).join("/");
  return (str) => {
    if (!fromKey || !target) return str;
    const current = parseTags(str);
    let hit = false;
    const next = current.map((t) => {
      const segs = tagPathSegments(t);
      const key = segs.map(tagKey).join("/");
      if (key !== fromKey && !key.startsWith(`${fromKey}/`)) return t;
      hit = true;
      return [target, ...segs.slice(fromDepth)].join("/");
    });
    if (!hit) return str;
    const out = formatTags(next);
    return out === str ? str : out;
  };
}

export type TagTransformPlan = {
  ids: number[];
  affected: number;
  tooLarge: boolean;
  truncated: boolean;
};

/** Which rows a transform changes, from a scan. Pure. */
export function planTagTransform(transform: (tags: string) => string, scan: TagScan): TagTransformPlan {
  const ids = scan.rows.filter((r) => transform(r.tags) !== r.tags).map((r) => r.id);
  return { ids, affected: ids.length, tooLarge: ids.length > TAG_OP_MAX_ROWS, truncated: scan.truncated };
}

export type PrefixRenamePlan = TagTransformPlan & {
  /** Distinct tags at or under the prefix. */
  tagCount: number;
  /** Renamed tags that already exist outside the branch (those merge). */
  collisions: string[];
};

/** Plan a prefix rename. Returns an error for an empty or no-op rename. */
export function planPrefixRename(
  from: string,
  to: string,
  scan: TagScan,
): { ok: true; plan: PrefixRenamePlan; transform: (tags: string) => string } | { ok: false; error: string } {
  const fromKey = tagPathKey(from);
  const toKey = tagPathKey(to);
  if (!fromKey) return { ok: false, error: "Name the tag prefix to rename." };
  if (!toKey) return { ok: false, error: "The new prefix must be a non-empty tag path." };
  if (to.includes(",")) return { ok: false, error: "A tag name can't contain a comma." };
  if (toKey.startsWith(`${fromKey}/`)) return { ok: false, error: "The new prefix can't be inside the branch being renamed." };
  const transform = renamePrefixTransform(from, to);
  const inBranch = (k: string) => k === fromKey || k.startsWith(`${fromKey}/`);
  const branch = new Set<string>();
  const outside = new Set<string>();
  for (const row of scan.rows) {
    for (const t of parseTags(row.tags)) {
      const k = tagPathKey(t);
      if (inBranch(k)) branch.add(k);
      else outside.add(k);
    }
  }
  const collisions = [...branch]
    .map((k) => (k === fromKey ? toKey : `${toKey}${k.slice(fromKey.length)}`))
    .filter((k) => outside.has(k));
  return { ok: true, transform, plan: { ...planTagTransform(transform, scan), tagCount: branch.size, collisions } };
}

/**
 * "Normalize spelling": tags stored under several spellings (same `tagKey`)
 * are rewritten to their most used spelling. `only` limits it to those tags
 * (any spelling); otherwise every tag with variants is normalized.
 */
export function planNormalizeSpelling(
  scan: TagScan,
  only?: readonly string[],
): { plan: TagTransformPlan & { tags: Array<{ tag: string; variants: string[] }> }; transform: (tags: string) => string } {
  const wanted = only && only.length ? new Set(toTagList(only).map(tagKey)) : null;
  const targets = summarizeTags(scan.rows)
    .filter((t) => t.hasVariants && (!wanted || wanted.has(t.key)))
    .map((t) => ({ tag: t.tag, variants: t.spellings.map((s) => s.spelling).filter((sp) => sp !== t.tag) }));
  const transform = (str: string) => targets.reduce((acc, t) => replaceTags(acc, [t.tag], t.tag), str);
  return { plan: { ...planTagTransform(transform, scan), tags: targets }, transform };
}
