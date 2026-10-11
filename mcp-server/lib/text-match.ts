/**
 * In-memory text filters over decrypted transaction rows.
 *
 * `payee`, `note` and `tags` are encrypted per row, so SQL can't match them;
 * `search_transactions` and the bulk preview/execute tools decrypt candidate
 * rows and run this predicate (driven by `scanInBatches`). One definition so
 * the two surfaces can't drift apart.
 *
 * Every set filter must match (AND). Within a filter:
 *   payee / note / tags → substring of that one field
 *   search              → substring of payee OR note OR tags
 *   tagExact            → one whole tag, via `hasExactTag` (`work` ≠ `homework`)
 * All comparisons run on `normalizeForMatch` text (case, apostrophes, Unicode
 * NFC, dashes, whitespace). An empty string (or a blank `tagExact`) counts as
 * "not set", matching how the tools always treated an empty `payee`.
 */
import { exactTagMatcher } from "../../src/lib/reports/tag-filter";
import {
  containsNormalized,
  containsNormalizedNeedle,
  normalizeForMatch,
} from "../../src/lib/text-normalize";

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

/** Normalized substring test (see `normalizeForMatch`); a null/absent value never matches. */
export function containsCI(value: unknown, needle: string): boolean {
  return containsNormalized(value, needle);
}

/** True when at least one filter would constrain the rows. */
export function hasTextFilter(f: TextFilters): boolean {
  return Boolean(f.payee || f.note || f.tags || f.search || f.tagExact?.trim());
}

/**
 * Build the row predicate once per filter set: the needles are normalized
 * here, not per row. Use this in scan loops.
 */
export function compileTextFilters(f: TextFilters): (row: TextRow) => boolean {
  const payee = f.payee ? normalizeForMatch(f.payee) : null;
  const note = f.note ? normalizeForMatch(f.note) : null;
  const tags = f.tags ? normalizeForMatch(f.tags) : null;
  const search = f.search ? normalizeForMatch(f.search) : null;
  const exact = f.tagExact?.trim() ? exactTagMatcher(f.tagExact) : null;
  return (row) => {
    if (payee != null && !containsNormalizedNeedle(row.payee, payee)) return false;
    if (note != null && !containsNormalizedNeedle(row.note, note)) return false;
    if (tags != null && !containsNormalizedNeedle(row.tags, tags)) return false;
    if (
      search != null &&
      !(
        containsNormalizedNeedle(row.payee, search) ||
        containsNormalizedNeedle(row.note, search) ||
        containsNormalizedNeedle(row.tags, search)
      )
    ) {
      return false;
    }
    if (exact && !exact(row.tags == null ? null : String(row.tags))) return false;
    return true;
  };
}

/** One-off form of {@link compileTextFilters}. */
export function matchesTextFilters(row: TextRow, f: TextFilters): boolean {
  return compileTextFilters(f)(row);
}
