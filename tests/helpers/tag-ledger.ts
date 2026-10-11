/**
 * In-memory stand-in for the two statements `rewriteTransactionTags`
 * (src/lib/transactions/rewrite-tags.ts) issues, so the tag writers can be
 * tested without a database. Rows keep real ciphertext; `serveTagSql` answers
 * the batch SELECT and applies the CASE UPDATE, scoped by user_id like SQL.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

export type LedgerRow = { id: number; userId: string; tags: string | null; updatedAt?: string };

const dialect = new PgDialect();

export function renderSql(query: SQL): { sql: string; params: unknown[] } {
  const r = dialect.sqlToQuery(query);
  return { sql: r.sql, params: r.params };
}

export const isTagBatchSelect = (s: string) => /^\s*SELECT id, tags FROM transactions\s+WHERE user_id = \$1 AND id = ANY/.test(s);
export const isTagCaseUpdate = (s: string) => /UPDATE transactions\s+SET tags = CASE id/.test(s);

/**
 * Serve a tag SELECT / UPDATE against `ledger`. Returns `undefined` for any
 * other statement so callers can chain their own handlers.
 */
export function serveTagSql(
  ledger: LedgerRow[],
  rendered: { sql: string; params: unknown[] },
): { rows: Array<Record<string, unknown>>; rowCount: number } | undefined {
  const { sql, params } = rendered;
  if (isTagBatchSelect(sql)) {
    const [userId, ...ids] = params as [string, ...number[]];
    const rows = ledger
      .filter((r) => r.userId === userId && ids.includes(r.id))
      .map((r) => ({ id: r.id, tags: r.tags }));
    return { rows, rowCount: rows.length };
  }
  if (isTagCaseUpdate(sql)) {
    const n = (params.length - 1) / 3;
    const values = new Map<number, string>();
    for (let i = 0; i < n; i++) values.set(Number(params[2 * i]), String(params[2 * i + 1]));
    const userId = params[2 * n] as string;
    const ids = (params.slice(2 * n + 1) as number[]).map(Number);
    let count = 0;
    for (const r of ledger) {
      if (r.userId === userId && ids.includes(r.id) && values.has(r.id)) {
        r.tags = values.get(r.id)!;
        r.updatedAt = "NOW";
        count++;
      }
    }
    return { rows: [], rowCount: count };
  }
  return undefined;
}
