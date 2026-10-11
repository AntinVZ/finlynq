/**
 * Batch writer for transaction tags.
 *
 * `transactions.tags` is encrypted per row, so a tag edit that depends on the
 * row's current tags (add / remove / rename / merge) can't be one SQL UPDATE:
 * each row is read, decrypted, transformed with a `lib/tags.ts` helper,
 * re-encrypted and written back. This module is the one place that loop lives,
 * shared by the web bulk route, the MCP bulk tools and `manage_tags`.
 *
 * Guarantees:
 *  - ownership: every SELECT and UPDATE is scoped by `user_id`, so ids that
 *    belong to someone else are silently skipped (never read, never written);
 *  - audit trio: every written row gets `updated_at = NOW()` (`source` is
 *    INSERT-only and never touched);
 *  - no-op rows (transform returns the same string) are not written;
 *  - a row whose ciphertext can't be decrypted is skipped, never overwritten;
 *  - work runs in batches of `batchSize` ids (one SELECT + one UPDATE each).
 *
 * Cache invalidation stays with the caller (`invalidateUserTxCache`), which
 * knows whether anything changed.
 */
import { sql, type SQL } from "drizzle-orm";
import { decryptField, encryptField } from "@/lib/crypto/envelope";
import { normalizeDbRows } from "@/lib/db-utils";

/** Anything with Drizzle's `execute` — the web `db`, a transaction, or the MCP `DbLike`. */
export type TagWriteExecutor = { execute: (query: SQL) => Promise<unknown> };

export const TAG_REWRITE_BATCH = 500;

export type TagRewriteResult = {
  /** Owned rows read. */
  scanned: number;
  /** Rows whose tags actually changed and were written. */
  changed: number;
  changedIds: number[];
  /** Rows skipped because their stored tags could not be decrypted. */
  undecryptable: number;
};

export async function rewriteTransactionTags(opts: {
  executor: TagWriteExecutor;
  userId: string;
  dek: Buffer | null;
  ids: readonly number[];
  /** Plaintext tags in, plaintext tags out. Return the input to leave a row alone. */
  transform: (tags: string) => string;
  batchSize?: number;
}): Promise<TagRewriteResult> {
  const { executor, userId, dek, transform } = opts;
  const batchSize = Math.max(1, opts.batchSize ?? TAG_REWRITE_BATCH);
  const ids = Array.from(new Set(opts.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)));
  const result: TagRewriteResult = { scanned: 0, changed: 0, changedIds: [], undecryptable: 0 };

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const idsExpr = sql.join(chunk.map((id) => sql`${id}`), sql`, `);
    const rows = normalizeDbRows<{ id: unknown; tags: unknown }>(
      await executor.execute(sql`
        SELECT id, tags FROM transactions
        WHERE user_id = ${userId} AND id = ANY(ARRAY[${idsExpr}]::int[])
      `),
    );
    result.scanned += rows.length;

    const writes: Array<{ id: number; value: string }> = [];
    for (const r of rows) {
      const stored = r.tags == null ? "" : String(r.tags);
      let plain: string;
      try {
        plain = dek ? (decryptField(dek, stored) ?? "") : stored;
      } catch {
        result.undecryptable++;
        continue;
      }
      // Without a DEK a ciphertext value can't be read — leave it alone.
      if (!dek && stored.startsWith("v1:")) {
        result.undecryptable++;
        continue;
      }
      const next = transform(plain);
      if (next === plain) continue;
      const value = dek ? (encryptField(dek, next) ?? "") : next;
      writes.push({ id: Number(r.id), value });
    }
    if (writes.length === 0) continue;

    const cases = sql.join(
      writes.map((w) => sql`WHEN ${w.id}::int THEN ${w.value}::text`),
      sql` `,
    );
    const writeIds = sql.join(writes.map((w) => sql`${w.id}`), sql`, `);
    await executor.execute(sql`
      UPDATE transactions
      SET tags = CASE id ${cases} END, updated_at = NOW()
      WHERE user_id = ${userId} AND id = ANY(ARRAY[${writeIds}]::int[])
    `);
    result.changed += writes.length;
    for (const w of writes) result.changedIds.push(w.id);
  }
  return result;
}
