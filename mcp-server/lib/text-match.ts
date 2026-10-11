/**
 * In-memory text filters over decrypted transaction rows.
 *
 * `payee`, `note` and `tags` are encrypted per row, so SQL can't match them;
 * `search_transactions` and the bulk preview/execute tools decrypt candidate
 * rows and run this predicate (driven by `scanInBatches`). One definition so
 * the two surfaces can't drift apart.
 *
 * Every set filter must match (AND). Within a filter:
 *   payee / note / tags → case-insensitive substring of that one field
 *   search              → case-insensitive substring of payee OR note OR tags
 *   tagExact            → one whole tag, via `hasExactTag` (`work` ≠ `homework`)
 * An empty string (or a blank `tagExact`) counts as "not set", matching how
 * the tools always treated an empty `payee`.
 */
import { hasExactTag } from "../../src/lib/reports/tag-filter";

export type TextFilters = {
  payee?: string;
  note?: string;
  tags?: string;
  search?: string;
  tagExact?: string;
};

export type TextRow = {
  payee?: unknown;
  note?: unknown;
  tags?: unknown;
};

/** Case-insensitive substring test; a null/absent value never matches. */
export function containsCI(value: unknown, needle: string): boolean {
  if (value == null) return false;
  return String(value).toLowerCase().includes(needle.toLowerCase());
}

/** True when at least one filter would constrain the rows. */
export function hasTextFilter(f: TextFilters): boolean {
  return Boolean(f.payee || f.note || f.tags || f.search || f.tagExact?.trim());
}

export function matchesTextFilters(row: TextRow, f: TextFilters): boolean {
  if (f.payee && !containsCI(row.payee, f.payee)) return false;
  if (f.note && !containsCI(row.note, f.note)) return false;
  if (f.tags && !containsCI(row.tags, f.tags)) return false;
  if (
    f.search &&
    !(containsCI(row.payee, f.search) || containsCI(row.note, f.search) || containsCI(row.tags, f.search))
  ) {
    return false;
  }
  const exact = f.tagExact?.trim();
  if (exact && !hasExactTag(row.tags == null ? null : String(row.tags), exact)) return false;
  return true;
}
