/**
 * Tag scoping for MCP report reads (`get_income_statement`,
 * `get_spending_trends`). `transactions.tags` is encrypted per row, so the
 * match can't run in SQL: callers decrypt the candidate rows and keep the ids
 * this predicate accepts.
 */

/**
 * Exact tag match against a transaction's comma-separated `tags` field
 * (already decrypted). Each tag is trimmed and compared case-insensitively —
 * the same identity the import pipeline uses when it de-dupes tags — but a
 * tag never matches as a substring: `work` does not match `homework`.
 * A blank `tag` matches nothing.
 */
export function hasExactTag(tags: string | null | undefined, tag: string): boolean {
  const want = tag.trim().toLowerCase();
  if (!want || !tags) return false;
  return tags.split(",").some((t) => t.trim().toLowerCase() === want);
}
