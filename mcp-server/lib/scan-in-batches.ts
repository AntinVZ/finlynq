/**
 * Paged scan for filters that can't run in SQL.
 *
 * `search_transactions` matches `payee` / `tags` / `tag_exact` against
 * per-row encrypted columns, so those predicates run in memory after
 * decryption. Fetching one fixed window (the old `max(limit*10, 500)` newest
 * rows) and filtering it silently dropped every older match. This walks the
 * SQL-filtered rows page by page, newest first, until `limit` matches are
 * collected or the rows run out.
 *
 * The walk is bounded by `maxScan` so a rare payee in a huge ledger can't turn
 * one call into a full-table decrypt. Hitting that bound before the rows run
 * out reports `truncated: true`: older matches may exist, and the caller
 * should narrow the SQL-side filters (dates, account) and ask again.
 */

export type ScanResult<T> = {
  /** Matches in fetch order, at most `limit`. */
  rows: T[];
  /** Rows read from the database (matched or not). */
  scanned: number;
  /** True when the scan stopped at `maxScan` with rows left unread. */
  truncated: boolean;
};

export async function scanInBatches<T>(opts: {
  /** One page of rows in a stable order; fewer than `size` means the end. */
  fetchPage: (offset: number, size: number) => Promise<T[]>;
  match: (row: T) => boolean;
  limit: number;
  batchSize: number;
  maxScan: number;
}): Promise<ScanResult<T>> {
  const { fetchPage, match, limit, batchSize, maxScan } = opts;
  const rows: T[] = [];
  let scanned = 0;
  if (limit <= 0) return { rows, scanned, truncated: false };

  while (rows.length < limit) {
    const remaining = maxScan - scanned;
    if (remaining <= 0) {
      // Out of budget. Only report truncation when something is actually
      // left unread: a one-row probe tells "exactly at the end" apart.
      const probe = await fetchPage(scanned, 1);
      return { rows, scanned, truncated: probe.length > 0 };
    }
    const size = Math.min(batchSize, remaining);
    const page = await fetchPage(scanned, size);
    scanned += page.length;
    for (const r of page) {
      if (match(r)) {
        rows.push(r);
        if (rows.length >= limit) break;
      }
    }
    if (page.length < size) break; // no more rows
  }
  return { rows, scanned, truncated: false };
}
