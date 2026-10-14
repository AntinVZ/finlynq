/**
 * Apply the directory to stored payees (Payee Studio P2): every row whose
 * payee resolves to an entity (through its aliases) is rewritten to the
 * entity's canonical name, in `transactions`, `recurring_transactions` and
 * `staged_transactions`.
 *
 * Never touched: `bank_transactions` (the immutable statement journal),
 * `simplefin_pending_transactions` (refreshed by every sync), `import_hash`
 * (computed over the ingest-time payee; dedup depends on it) and a staged
 * row's `encryption_tier` (the row is re-encrypted at its own tier).
 *
 * `planPayeeApply` is read only: it pages through the tables (keyset),
 * decrypts, matches in memory and keeps only row ids. `runPayeeApply`
 * re-reads each planned row inside the batch transaction, re-checks the
 * match, writes the canonical name and journals the old / new stored value
 * so the batch can be undone. Payees that match two entities are reported
 * as conflicts and left alone.
 */
import { createHash } from "crypto";
import { sql, type SQL } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { encryptField } from "@/lib/crypto/envelope";
import { encryptStaged } from "@/lib/crypto/staging-envelope";
import { decodeStoredPayee, spellingOf, type PayeeExecutor } from "./scan";
import { readStoredPayees, writeStoredPayees, type PayeeBatchJournal, type RewriteTable } from "./batches";
import type { PayeeMatcher } from "./directory";
import { caseOnlyChange, payeeMatchKey } from "./match-key";
import { st } from "@/lib/i18n/current";

/** Most rows one apply may rewrite (undo data grows with it). */
export const PAYEE_APPLY_MAX_ROWS = 20_000;
const SCAN_BATCH = 2_000;
const SCAN_MAX_PER_TABLE = 250_000;

export const REWRITE_TABLES: readonly RewriteTable[] = ["transactions", "recurring", "staged"];

export type ApplyPlan = {
  rows: Array<{ t: RewriteTable; id: string; entityId: number }>;
  byTable: Record<RewriteTable, number>;
  /** Distinct spellings that will change, most rows first. */
  /** P6.2: `caseOnly` = the rename changes nothing but letter case. */
  changes: Array<{ from: string; to: string; entityId: number; count: number; caseOnly: boolean }>;
  /** Payees matching two or more entities: left alone. */
  conflicts: Array<{ payee: string; entities: string[]; count: number }>;
  total: number;
  tooLarge: boolean;
  truncated: boolean;
  /** Why nothing (or little) matched — filled for the preview's explanation. */
  diagnostics: ApplyDiagnostics;
};

/**
 * What the scan saw besides the hits, so an empty preview can say WHY:
 * rows that already carry the canonical name, rows that couldn't be
 * decrypted, and spellings that look like a target entity (share a word of
 * one of its aliases' keys) but match none of its aliases.
 */
export type ApplyDiagnostics = {
  scanned: number;
  undecryptable: number;
  alreadyCanonical: number;
  nearMisses: Array<{ payee: string; entityId: number; count: number }>;
};

/** Words of an alias key that are specific enough to flag a near miss. */
const nearMissTokens = (key: string) => key.split(" ").filter((t) => t.length >= 4 && !/^\d+$/.test(t));

/**
 * One keyset page per table. The serial tables select `id` as is: aliasing
 * `id::text AS id` would make `ORDER BY id` sort by the TEXT alias ("1",
 * "10", "100", "2", …) while `id > n` compares numbers, so every page after
 * the first skipped rows (B23: apply found 0 of ~300 rows on a real ledger).
 */
const PAGES: Record<RewriteTable, (userId: string, after: string | null, size: number) => SQL> = {
  transactions: (userId, after, size) => sql`
    SELECT id, payee, NULL AS tier FROM transactions
    WHERE user_id = ${userId} ${after != null ? sql`AND id > ${Number(after)}` : sql``} ORDER BY id LIMIT ${size}`,
  recurring: (userId, after, size) => sql`
    SELECT id, payee, NULL AS tier FROM recurring_transactions
    WHERE user_id = ${userId} ${after != null ? sql`AND id > ${Number(after)}` : sql``} ORDER BY id LIMIT ${size}`,
  staged: (userId, after, size) => sql`
    SELECT id, payee, encryption_tier AS tier FROM staged_transactions
    WHERE user_id = ${userId} ${after != null ? sql`AND id > ${after}` : sql``} ORDER BY id LIMIT ${size}`,
};

/**
 * Which rows the directory would rewrite. `entityIds` limits the result to
 * those entities (the matcher still sees the whole directory, so a payee
 * that also matches another entity is a conflict, not a hit).
 */
export async function planPayeeApply(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  matcher: PayeeMatcher;
  entityIds?: ReadonlySet<number>;
  tables?: readonly RewriteTable[];
}): Promise<ApplyPlan> {
  const { executor, userId, dek, matcher, entityIds } = opts;
  const plan: ApplyPlan = {
    rows: [],
    byTable: { transactions: 0, recurring: 0, staged: 0 },
    changes: [],
    conflicts: [],
    total: 0,
    tooLarge: false,
    truncated: false,
    diagnostics: { scanned: 0, undecryptable: 0, alreadyCanonical: 0, nearMisses: [] },
  };
  // Alias-key words of the target entities → entity ids (near-miss lookup).
  const nearIndex = new Map<string, Set<number>>();
  for (const e of matcher.entities) {
    if (entityIds && !entityIds.has(e.id)) continue;
    for (const a of e.aliases) {
      for (const t of nearMissTokens(payeeMatchKey(a.pattern))) {
        const set = nearIndex.get(t) ?? new Set<number>();
        set.add(e.id);
        nearIndex.set(t, set);
      }
    }
  }
  const near = new Map<string, { payee: string; entityId: number; count: number }>();
  const changes = new Map<string, ApplyPlan["changes"][number]>();
  const conflicts = new Map<string, { payee: string; entities: string[]; count: number }>();
  for (const t of opts.tables ?? REWRITE_TABLES) {
    let after: string | null = null;
    let scanned = 0;
    for (;;) {
      const size = Math.min(SCAN_BATCH, SCAN_MAX_PER_TABLE - scanned);
      if (size <= 0) {
        plan.truncated = normalizeDbRows(await executor.execute(PAGES[t](userId, after, 1))).length > 0 || plan.truncated;
        break;
      }
      const page: Array<Record<string, unknown>> = normalizeDbRows<Record<string, unknown>>(await executor.execute(PAGES[t](userId, after, size)));
      scanned += page.length;
      plan.diagnostics.scanned += page.length;
      for (const r of page) {
        after = String(r.id);
        const plain = decodeStoredPayee(r.payee, r.tier == null ? null : String(r.tier), dek);
        if (plain === undefined) {
          plan.diagnostics.undecryptable++;
          continue;
        }
        const spelling = spellingOf(plain);
        if (!spelling) continue;
        const m = matcher.match(spelling);
        if (m.kind === "none" && nearIndex.size) {
          const hit = nearMissTokens(payeeMatchKey(spelling)).map((t) => nearIndex.get(t)).find((x) => x != null);
          if (hit) {
            const entityId = Math.min(...hit);
            const nk = `${entityId}\u0000${spelling}`;
            const n = near.get(nk) ?? { payee: spelling, entityId, count: 0 };
            n.count++;
            near.set(nk, n);
          }
          continue;
        }
        if (m.kind === "ambiguous") {
          if (entityIds && !m.entityIds.some((id) => entityIds.has(id))) continue;
          const c = conflicts.get(spelling) ?? { payee: spelling, entities: m.names, count: 0 };
          c.count++;
          conflicts.set(spelling, c);
          continue;
        }
        if (m.kind !== "match" || (entityIds && !entityIds.has(m.entityId))) continue;
        if (plain === m.name) {
          plan.diagnostics.alreadyCanonical++;
          continue;
        }
        plan.rows.push({ t, id: String(r.id), entityId: m.entityId });
        plan.byTable[t]++;
        const ck = `${m.entityId}\u0000${plain}`;
        const c = changes.get(ck) ?? { from: plain, to: m.name, entityId: m.entityId, count: 0, caseOnly: caseOnlyChange(plain, m.name) };
        c.count++;
        changes.set(ck, c);
      }
      if (page.length < size) break;
    }
  }
  plan.total = plan.rows.length;
  plan.tooLarge = plan.total > PAYEE_APPLY_MAX_ROWS;
  plan.changes = [...changes.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
  plan.conflicts = [...conflicts.values()].sort((a, b) => b.count - a.count);
  plan.diagnostics.nearMisses = [...near.values()].sort((a, b) => b.count - a.count || a.payee.localeCompare(b.payee));
  return plan;
}

/**
 * The preview's explanation when an apply finds nothing to rename (B23):
 * never a silent "0 rows". `names` maps entity id → canonical name.
 */
export function explainEmptyApply(plan: Pick<ApplyPlan, "total" | "conflicts" | "diagnostics" | "truncated">, names: (id: number) => string | undefined): string | null {
  if (plan.total > 0) return null;
  const d = plan.diagnostics;
  const parts: string[] = [];
  if (d.nearMisses.length) {
    const sample = d.nearMisses.slice(0, 3).map((n) => `«${n.payee}»`).join(", ");
    const who = [...new Set(d.nearMisses.map((n) => names(n.entityId)).filter(Boolean))].slice(0, 2).map((n) => `«${n}»`).join(", ");
    const rows = d.nearMisses.reduce((a, n) => a + n.count, 0);
    parts.push(
      st("srv.apply.nearMisses", { n: d.nearMisses.length, rows, who, sample }),
    );
  }
  if (d.alreadyCanonical) parts.push(st("srv.apply.alreadyCanonical", { n: d.alreadyCanonical }));
  if (plan.conflicts.length) parts.push(st("srv.apply.conflicts", { n: plan.conflicts.length }));
  if (d.undecryptable) parts.push(st("srv.apply.undecryptable", { n: d.undecryptable }));
  if (plan.truncated) parts.push(st("srv.apply.truncated"));
  if (!parts.length) parts.push(d.scanned ? st("srv.apply.noMatch", { n: d.scanned }) : st("srv.apply.noRows"));
  return st("srv.apply.nothingRenamed", { details: parts.join(" ") });
}

/** A short stable fingerprint of a plan's rows (binds MCP confirmation tokens). */
export function planFingerprint(plan: Pick<ApplyPlan, "rows">): string {
  const h = createHash("sha256");
  for (const r of plan.rows) h.update(`${r.t}:${r.id}:${r.entityId};`);
  return h.digest("hex").slice(0, 32);
}

/** Encrypt a canonical name for a table / staging tier. */
function encodeFor(t: RewriteTable, tier: string | null, dek: Buffer, name: string): string | null {
  if (t === "staged" && tier !== "user") return encryptStaged(name);
  return encryptField(dek, name);
}

/**
 * Rewrite the planned rows inside a batch. Each row is re-read and
 * re-matched first; a row that changed since the plan is skipped.
 */
export async function runPayeeApply(opts: {
  tx: PayeeExecutor;
  journal: PayeeBatchJournal;
  userId: string;
  dek: Buffer;
  matcher: PayeeMatcher;
  plan: Pick<ApplyPlan, "rows">;
}): Promise<{ changed: number; skipped: number; byTable: Record<RewriteTable, number> }> {
  const { tx, journal, userId, dek, matcher } = opts;
  const byTable: Record<RewriteTable, number> = { transactions: 0, recurring: 0, staged: 0 };
  let skipped = 0;
  for (const t of REWRITE_TABLES) {
    const planned = opts.plan.rows.filter((r) => r.t === t);
    if (!planned.length) continue;
    const current = await readStoredPayees(tx, userId, t, planned.map((r) => r.id));
    const writes: Array<{ id: string; value: string | null }> = [];
    for (const p of planned) {
      const cur = current.get(p.id);
      const plain = cur ? decodeStoredPayee(cur.payee, cur.tier, dek) : undefined;
      const m = plain === undefined ? null : matcher.match(spellingOf(plain));
      if (!cur || plain === undefined || !m || m.kind !== "match" || m.entityId !== p.entityId || plain === m.name) {
        skipped++;
        continue;
      }
      const value = encodeFor(t, cur.tier, dek, m.name);
      writes.push({ id: p.id, value });
      journal.rowChanged({ t, id: p.id, old: cur.payee, new: value });
    }
    await writeStoredPayees(tx, userId, t, writes);
    byTable[t] = writes.length;
  }
  const changed = byTable.transactions + byTable.recurring + byTable.staged;
  journal.count("transactions", byTable.transactions);
  journal.count("recurring", byTable.recurring);
  journal.count("staged", byTable.staged);
  return { changed, skipped, byTable };
}
