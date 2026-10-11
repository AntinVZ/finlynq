/**
 * Tag scoping for MCP report reads (`get_income_statement`,
 * `get_spending_trends`). `transactions.tags` is encrypted per row, so the
 * match can't run in SQL: callers decrypt the candidate rows and keep the ids
 * this predicate accepts.
 */
import { normalizeForMatch } from "../text-normalize";

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
