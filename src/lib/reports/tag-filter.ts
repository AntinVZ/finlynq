/**
 * Tag predicates shared by every surface that filters by tag: MCP
 * `search_transactions`, the bulk tools, `get_income_statement` /
 * `get_spending_trends`, and `GET /api/transactions`. `transactions.tags` is
 * encrypted per row, so the match can't run in SQL: callers decrypt the
 * candidate rows and keep the ones these predicates accept.
 */
import { normalizeForMatch } from "../text-normalize";
import { parseTags, tagKey, toTagList } from "../tags";

/**
 * Exact tag match against a transaction's comma-separated `tags` field
 * (already decrypted). Both sides go through `normalizeForMatch` (trim, case,
 * apostrophes, Unicode NFC, dashes, whitespace) — but a tag never matches as
 * a substring: `work` does not match `homework`. A blank `tag` matches nothing.
 */
export function hasExactTag(tags: string | null | undefined, tag: string): boolean {
  return exactTagMatcher(tag)(tags);
}

/** {@link hasExactTag} with the wanted tag normalized once — use in row loops. */
export function exactTagMatcher(tag: string): (tags: string | null | undefined) => boolean {
  const want = normalizeForMatch(tag);
  return (tags) => {
    if (!want || !tags) return false;
    return tags.split(",").some((t) => normalizeForMatch(t) === want);
  };
}

/**
 * Multi-tag filter (all optional, combined with AND):
 *   all      — the row carries every one of these tags
 *   any      — the row carries at least one of these tags
 *   none     — the row carries none of these tags
 *   untagged — true: the row has no tags at all (false / absent: no constraint)
 * Values are whole tags compared with `normalizeForMatch` — the same identity
 * as {@link hasExactTag} and lib/tags.ts. An empty list counts as "not set".
 */
export type TagFilter = {
  all?: readonly string[];
  any?: readonly string[];
  none?: readonly string[];
  untagged?: boolean;
};

/** Raw wire values: a comma list or an array per key; untagged as a boolean or "true"/"false". */
export type TagFilterInput = {
  tags_all?: string | readonly string[] | null;
  tags_any?: string | readonly string[] | null;
  tags_none?: string | readonly string[] | null;
  untagged?: boolean | string | null;
};

/** Parse the wire params (MCP args or query params) into a {@link TagFilter}. */
export function parseTagFilter(input: TagFilterInput): TagFilter {
  const f: TagFilter = {};
  const all = toTagList(input.tags_all);
  const any = toTagList(input.tags_any);
  const none = toTagList(input.tags_none);
  if (all.length) f.all = all;
  if (any.length) f.any = any;
  if (none.length) f.none = none;
  const u = input.untagged;
  if (u === true || (typeof u === "string" && u.trim().toLowerCase() === "true")) f.untagged = true;
  return f;
}

/** True when the filter would constrain any row. */
export function hasTagFilter(f: TagFilter | null | undefined): boolean {
  return !!f && !!(f.all?.length || f.any?.length || f.none?.length || f.untagged);
}

/**
 * Build the row predicate once (tags normalized here, not per row). Returns
 * null when the filter is empty, so callers can skip the decrypt pass.
 */
export function compileTagFilter(f: TagFilter | null | undefined): ((tags: string | null | undefined) => boolean) | null {
  if (!hasTagFilter(f)) return null;
  const all = (f!.all ?? []).map(tagKey).filter(Boolean);
  const any = (f!.any ?? []).map(tagKey).filter(Boolean);
  const none = new Set((f!.none ?? []).map(tagKey).filter(Boolean));
  const untagged = f!.untagged === true;
  return (tags) => {
    const have = new Set(parseTags(tags).map(tagKey));
    if (untagged && have.size > 0) return false;
    for (const k of all) if (!have.has(k)) return false;
    if (any.length && !any.some((k) => have.has(k))) return false;
    for (const k of none) if (have.has(k)) return false;
    return true;
  };
}

/** One-off form of {@link compileTagFilter}; an empty filter matches every row. */
export function matchesTagFilter(tags: string | null | undefined, f: TagFilter | null | undefined): boolean {
  const m = compileTagFilter(f);
  return m ? m(tags) : true;
}

/**
 * True when rows WITHOUT tags can match — callers that pre-filter SQL to
 * rows with a non-empty `tags` column must not do so in that case.
 */
export function tagFilterAcceptsUntagged(f: TagFilter | null | undefined): boolean {
  if (!hasTagFilter(f)) return true;
  return !(f!.all?.length || f!.any?.length);
}
