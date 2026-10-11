/**
 * Payee batches (Payee Studio P2): every directory change and every payee
 * rewrite runs inside one DB transaction and leaves one `payee_batches` row
 * that can undo it for 30 days.
 *
 * What a batch remembers (the encrypted `undo_data` JSON):
 *   - `before`: the stored rows (ciphertext as stored) of every entity the
 *     batch touched, with their aliases and identifiers — snapshotted lazily
 *     by `journal.willModify(ids)` before the first change;
 *   - `created`: ids of entities the batch created;
 *   - `rows`: for every rewritten payee, the table, row id and the stored
 *     value before and after (ciphertext — the blob is encrypted anyway).
 * `summary` (plain JSONB) holds counts only — never names or payees.
 *
 * Undo:
 *   - refused when the batch is already undone, older than 30 days, or a
 *     NEWER, not-undone batch touched one of the same entities (undo that one
 *     first — directory snapshots only restore cleanly newest-first);
 *   - payee rows are restored only where the stored value is still exactly
 *     what the batch wrote; rows changed since are left alone and counted as
 *     `skipped`;
 *   - the touched entities are restored from the snapshot (created ones are
 *     deleted).
 * `bank_transactions` is never part of a batch and `import_hash` is never
 * touched.
 */
import { sql, type SQL } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import type { PayeeExecutor } from "./scan";

export const PAYEE_BATCH_TTL_DAYS = 30;

export type BatchActor = "web" | "mcp" | "autopilot" | "import";
export type RewriteTable = "transactions" | "recurring" | "staged";

type StoredRow = Record<string, unknown>;
type Snapshot = { entities: StoredRow[]; aliases: StoredRow[]; identifiers: StoredRow[] };
export type RowChange = { t: RewriteTable; id: string; old: string | null; new: string | null };
type UndoData = { v: 1; before: Snapshot; snapshotIds: number[]; created: number[]; rows: RowChange[] };

export class PayeeBatchError extends Error {
  constructor(message: string, public readonly code: string = "invalid") {
    super(message);
  }
}

type TxCapable = { transaction: <T>(fn: (tx: PayeeExecutor) => Promise<T>) => Promise<T> };

/** Run `fn` in a DB transaction when the executor supports one (tests pass plain executors). */
export async function inTransaction<T>(executor: PayeeExecutor, fn: (tx: PayeeExecutor) => Promise<T>): Promise<T> {
  const maybe = executor as unknown as Partial<TxCapable>;
  if (typeof maybe.transaction === "function") return maybe.transaction(fn);
  return fn(executor);
}

const idList = (ids: readonly number[]): SQL => sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::int[]`;

const toJsonRow = (r: StoredRow): StoredRow => {
  const out: StoredRow = {};
  for (const [k, v] of Object.entries(r)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
};

async function snapshot(tx: PayeeExecutor, userId: string, ids: number[]): Promise<Snapshot> {
  if (!ids.length) return { entities: [], aliases: [], identifiers: [] };
  const q = async (query: SQL) => normalizeDbRows<StoredRow>(await tx.execute(query)).map(toJsonRow);
  return {
    entities: await q(sql`SELECT id, name, type, note, default_category_id, created_at, updated_at FROM payee_entities WHERE user_id = ${userId} AND id = ANY(${idList(ids)}) FOR UPDATE`),
    aliases: await q(sql`SELECT id, entity_id, pattern, mode, key_hash, source, created_at FROM payee_aliases WHERE user_id = ${userId} AND entity_id = ANY(${idList(ids)})`),
    identifiers: await q(sql`SELECT id, entity_id, kind, value, created_at FROM payee_identifiers WHERE user_id = ${userId} AND entity_id = ANY(${idList(ids)})`),
  };
}

/** Collects what a batch changes. Handed to the batch body. */
export class PayeeBatchJournal {
  readonly created: number[] = [];
  readonly rows: RowChange[] = [];
  readonly summary: Record<string, number> = {};
  private readonly snap: Snapshot = { entities: [], aliases: [], identifiers: [] };
  private readonly snapped = new Set<number>();

  constructor(private readonly tx: PayeeExecutor, private readonly userId: string) {}

  /** Snapshot existing entities before the first change to them. Idempotent. */
  async willModify(ids: Iterable<number>): Promise<void> {
    const fresh = [...new Set(ids)].filter((id) => !this.snapped.has(id) && !this.created.includes(id));
    if (!fresh.length) return;
    const s = await snapshot(this.tx, this.userId, fresh);
    for (const id of fresh) this.snapped.add(id);
    this.snap.entities.push(...s.entities);
    this.snap.aliases.push(...s.aliases);
    this.snap.identifiers.push(...s.identifiers);
  }

  createdEntity(id: number): void {
    this.created.push(id);
  }

  rowChanged(change: RowChange): void {
    this.rows.push(change);
  }

  count(key: string, n = 1): void {
    this.summary[key] = (this.summary[key] ?? 0) + n;
  }

  get entityIds(): number[] {
    return [...new Set([...this.snapped, ...this.created])].sort((a, b) => a - b);
  }

  undoData(): UndoData {
    return { v: 1, before: this.snap, snapshotIds: [...this.snapped], created: [...this.created], rows: this.rows };
  }
}

export type BatchResult<T> = { result: T; batchId: number | null };

/**
 * Run a batch body in one transaction and journal it. A body that changed
 * nothing (no rows, no entities touched) leaves no batch row.
 */
export async function runPayeeBatch<T>(
  opts: { executor: PayeeExecutor; userId: string; dek: Buffer; kind: string; actor: BatchActor },
  body: (tx: PayeeExecutor, journal: PayeeBatchJournal) => Promise<T>,
): Promise<BatchResult<T>> {
  const { userId, dek } = opts;
  return inTransaction(opts.executor, async (tx) => {
    const journal = new PayeeBatchJournal(tx, userId);
    const result = await body(tx, journal);
    if (journal.rows.length === 0 && journal.entityIds.length === 0) return { result, batchId: null };
    const summary = { ...journal.summary, rows: journal.rows.length };
    const undo = encryptField(dek, JSON.stringify(journal.undoData()));
    const rows = normalizeDbRows<{ id: unknown }>(
      await tx.execute(sql`
        INSERT INTO payee_batches (user_id, kind, actor, summary, entity_ids, undo_data, expires_at)
        VALUES (${userId}, ${opts.kind}, ${opts.actor}, ${JSON.stringify(summary)}::jsonb,
                ${journal.entityIds.length ? idList(journal.entityIds) : sql`'{}'::int[]`}, ${undo},
                NOW() + (${PAYEE_BATCH_TTL_DAYS} || ' days')::interval)
        RETURNING id`),
    );
    return { result, batchId: Number(rows[0].id) };
  });
}

// ─── list ───────────────────────────────────────────────────────────────────

export type PayeeBatchInfo = {
  id: number;
  kind: string;
  actor: string;
  summary: Record<string, number>;
  entityIds: number[];
  createdAt: string;
  expiresAt: string;
  undoneAt: string | null;
  /** Not undone, not expired. (A newer overlapping batch may still block it.) */
  canUndo: boolean;
};

export async function listPayeeBatches(
  executor: PayeeExecutor,
  userId: string,
  opts: { entityId?: number; limit?: number } = {},
): Promise<PayeeBatchInfo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = normalizeDbRows<StoredRow>(
    await executor.execute(sql`
      SELECT id, kind, actor, summary, entity_ids, created_at, expires_at, undone_at, (expires_at > NOW()) AS live
      FROM payee_batches
      WHERE user_id = ${userId} ${opts.entityId != null ? sql`AND ${opts.entityId}::int = ANY(entity_ids)` : sql``}
      ORDER BY id DESC LIMIT ${limit}`),
  );
  return rows.map((r) => {
    const summary = typeof r.summary === "string" ? JSON.parse(r.summary) : (r.summary as Record<string, number>) ?? {};
    const ids = Array.isArray(r.entity_ids) ? r.entity_ids.map(Number) : String(r.entity_ids ?? "").replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
    const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
    return {
      id: Number(r.id),
      kind: String(r.kind),
      actor: String(r.actor),
      summary,
      entityIds: ids,
      createdAt: ts(r.created_at),
      expiresAt: ts(r.expires_at),
      undoneAt: r.undone_at == null ? null : ts(r.undone_at),
      canUndo: r.undone_at == null && (r.live === true || r.live === "t"),
    };
  });
}

// ─── undo ───────────────────────────────────────────────────────────────────

const TABLE_SQL: Record<RewriteTable, { table: SQL; numeric: boolean; audit: boolean }> = {
  transactions: { table: sql`transactions`, numeric: true, audit: true },
  recurring: { table: sql`recurring_transactions`, numeric: true, audit: false },
  staged: { table: sql`staged_transactions`, numeric: false, audit: false },
};

/** Write stored payee values back by id (CASE update, user-scoped, in chunks). */
export async function writeStoredPayees(
  tx: PayeeExecutor,
  userId: string,
  t: RewriteTable,
  writes: Array<{ id: string; value: string | null }>,
): Promise<void> {
  const spec = TABLE_SQL[t];
  for (let i = 0; i < writes.length; i += 500) {
    const chunk = writes.slice(i, i + 500);
    const idExpr = (id: string) => (spec.numeric ? sql`${Number(id)}::int` : sql`${id}::text`);
    const cases = sql.join(chunk.map((w) => sql`WHEN ${idExpr(w.id)} THEN ${w.value}::text`), sql` `);
    const ids = sql.join(chunk.map((w) => idExpr(w.id)), sql`, `);
    await tx.execute(sql`
      UPDATE ${spec.table}
      SET payee = CASE id ${cases} END${spec.audit ? sql`, updated_at = NOW()` : sql``}
      WHERE user_id = ${userId} AND id IN (${ids})`);
  }
}

/** Read stored payee values (and the staging tier) by id. */
export async function readStoredPayees(
  tx: PayeeExecutor,
  userId: string,
  t: RewriteTable,
  ids: readonly string[],
): Promise<Map<string, { payee: string | null; tier: string | null }>> {
  const spec = TABLE_SQL[t];
  const out = new Map<string, { payee: string | null; tier: string | null }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const list = sql.join(chunk.map((id) => (spec.numeric ? sql`${Number(id)}::int` : sql`${id}::text`)), sql`, `);
    const rows = normalizeDbRows<StoredRow>(
      await tx.execute(sql`
        SELECT id::text AS id, payee, ${t === "staged" ? sql`encryption_tier` : sql`NULL`} AS tier
        FROM ${spec.table} WHERE user_id = ${userId} AND id IN (${list}) FOR UPDATE`),
    );
    for (const r of rows) out.set(String(r.id), { payee: r.payee == null ? null : String(r.payee), tier: r.tier == null ? null : String(r.tier) });
  }
  return out;
}

export type UndoResult = { batchId: number; restoredRows: number; skippedRows: number; restoredEntities: number; removedEntities: number };

export async function undoPayeeBatch(opts: { executor: PayeeExecutor; userId: string; dek: Buffer; batchId: number }): Promise<UndoResult> {
  const { userId, dek, batchId } = opts;
  return inTransaction(opts.executor, async (tx) => {
    const [b] = normalizeDbRows<StoredRow>(
      await tx.execute(sql`
        SELECT id, entity_ids, undo_data, undone_at, (expires_at > NOW()) AS live
        FROM payee_batches WHERE id = ${batchId} AND user_id = ${userId} FOR UPDATE`),
    );
    if (!b) throw new PayeeBatchError(`No change batch #${batchId}.`, "not_found");
    if (b.undone_at != null) throw new PayeeBatchError(`Batch #${batchId} was already undone.`, "already_undone");
    if (!(b.live === true || b.live === "t")) throw new PayeeBatchError(`Batch #${batchId} is older than ${PAYEE_BATCH_TTL_DAYS} days and can no longer be undone.`, "expired");
    const plain = b.undo_data == null ? null : tryDecryptField(dek, String(b.undo_data), "payee-batch-undo");
    if (!plain) throw new PayeeBatchError(`Batch #${batchId} has no readable undo data.`, "no_undo_data");
    const undo = JSON.parse(plain) as UndoData;
    const entityIds = [...new Set([...undo.snapshotIds, ...undo.created])];
    if (entityIds.length) {
      const newer = normalizeDbRows<{ id: unknown }>(
        await tx.execute(sql`
          SELECT id FROM payee_batches
          WHERE user_id = ${userId} AND id > ${batchId} AND undone_at IS NULL AND entity_ids && ${idList(entityIds)}
          ORDER BY id DESC`),
      );
      if (newer.length) {
        throw new PayeeBatchError(
          `A newer change (batch ${newer.map((r) => `#${Number(r.id)}`).join(", ")}) touched the same payees. Undo it first.`,
          "newer_batch",
        );
      }
    }

    // 1. Payee rows: restore only what is still exactly what we wrote.
    let restoredRows = 0;
    let skippedRows = 0;
    for (const t of ["transactions", "recurring", "staged"] as RewriteTable[]) {
      const changes = undo.rows.filter((r) => r.t === t);
      if (!changes.length) continue;
      const current = await readStoredPayees(tx, userId, t, changes.map((c) => c.id));
      const writes: Array<{ id: string; value: string | null }> = [];
      for (const c of changes) {
        const cur = current.get(c.id);
        if (cur && cur.payee === c.new) writes.push({ id: c.id, value: c.old });
        else skippedRows++;
      }
      await writeStoredPayees(tx, userId, t, writes);
      restoredRows += writes.length;
    }

    // 2. Directory: drop the touched + created entities, restore the snapshot.
    if (entityIds.length) {
      await tx.execute(sql`DELETE FROM payee_entities WHERE user_id = ${userId} AND id = ANY(${idList(entityIds)})`);
      for (const e of undo.before.entities) {
        await tx.execute(sql`
          INSERT INTO payee_entities (id, user_id, name, type, note, default_category_id, created_at, updated_at)
          VALUES (${Number(e.id)}, ${userId}, ${e.name as string}, ${e.type as string}, ${(e.note as string | null) ?? null},
                  (SELECT id FROM categories WHERE id = ${e.default_category_id == null ? null : Number(e.default_category_id)} AND user_id = ${userId}),
                  ${e.created_at as string}::timestamptz, ${e.updated_at as string}::timestamptz)`);
      }
      for (const a of undo.before.aliases) {
        await tx.execute(sql`
          INSERT INTO payee_aliases (id, user_id, entity_id, pattern, mode, key_hash, source, created_at)
          VALUES (${Number(a.id)}, ${userId}, ${Number(a.entity_id)}, ${a.pattern as string}, ${a.mode as string},
                  ${(a.key_hash as string | null) ?? null}, ${a.source as string}, ${a.created_at as string}::timestamptz)`);
      }
      for (const i of undo.before.identifiers) {
        await tx.execute(sql`
          INSERT INTO payee_identifiers (id, user_id, entity_id, kind, value, created_at)
          VALUES (${Number(i.id)}, ${userId}, ${Number(i.entity_id)}, ${i.kind as string}, ${i.value as string}, ${i.created_at as string}::timestamptz)`);
      }
    }
    await tx.execute(sql`UPDATE payee_batches SET undone_at = NOW() WHERE id = ${batchId} AND user_id = ${userId}`);
    return {
      batchId,
      restoredRows,
      skippedRows,
      restoredEntities: undo.before.entities.length,
      removedEntities: undo.created.length,
    };
  });
}
