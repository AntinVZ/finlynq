/**
 * Paging for the large Payee Studio MCP answers (P8 stage 9, B7): `list`,
 * `clusters` and `review` take an opaque `cursor` and answer with the same
 * three fields — `truncated` (more rows exist than this page holds),
 * `next_cursor` (pass it back for the next page; absent on the last page)
 * and `total`. The cursor is the offset in the ordered result, so a page
 * may shift when payees change between calls; that is said in the note.
 * Compact mode keeps only what a model needs to decide (names, keys,
 * counts, sums) and is sent without indentation.
 */

const PREFIX = "o:";

export function encodeCursor(offset: number): string {
  return Buffer.from(`${PREFIX}${offset}`, "utf8").toString("base64url");
}

/** The offset in a cursor, or 0 for none / a cursor this code didn't make. */
export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return 0;
  }
  if (!raw.startsWith(PREFIX)) return 0;
  const n = Number(raw.slice(PREFIX.length));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export type Page<T> = { items: T[]; total: number; truncated: boolean; next_cursor?: string };

export function pageOf<T>(all: readonly T[], opts: { cursor?: string | null; limit: number }): Page<T> {
  const start = Math.min(decodeCursor(opts.cursor), all.length);
  const limit = Math.max(1, Math.floor(opts.limit));
  const end = Math.min(start + limit, all.length);
  const truncated = end < all.length;
  return {
    items: all.slice(start, end),
    total: all.length,
    truncated,
    ...(truncated ? { next_cursor: encodeCursor(end) } : {}),
  };
}

/** The page fields every paged op returns, in one place. */
export function pageMeta<T>(p: Page<T>): { total: number; truncated: boolean; next_cursor?: string } {
  return { total: p.total, truncated: p.truncated, ...(p.next_cursor ? { next_cursor: p.next_cursor } : {}) };
}
