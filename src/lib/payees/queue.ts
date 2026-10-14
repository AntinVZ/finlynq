/**
 * The Merchants decision queue (P8 stage 1): how many things wait for a
 * person's decision — merge candidates, look-alike spellings, AI drafts,
 * entries to check — plus unrecognized payees (shown in the queue, not
 * counted in the menu badge: they are not decisions, just a backlog).
 *
 * Counting needs the full decrypted overview, so the result is cached per
 * user for QUEUE_TTL_MS and dropped on every directory change (see
 * `invalidatePayeeSuggest`, which every write path already calls).
 */
import { sql } from "drizzle-orm";
import type { PayeeExecutor } from "./scan";
import { invalidatePayeeQueue, queueCache, type QueueCacheEntry } from "./queue-cache";
import { loadLookalikes, loadPayeeOverview, suspiciousOf, type PayeeOverview } from "./service";

export type QueueCounts = {
  /** Clusters of similar spellings (merge candidates). */
  clusters: number;
  /** Clusters a person must decide on (private persons / ФОП). */
  needsDecision: number;
  /** Spellings that look like a directory entry and are not in it yet. */
  lookalikes: number;
  /** AI proposals awaiting review. */
  drafts: number;
  /** Directory entries with a short / meaningless name to check. */
  suspicious: number;
  /** Payees not in the directory (a backlog, not counted in `decisions`). */
  unrecognized: number;
  /** What the menu badge shows: clusters + lookalikes + drafts + suspicious. */
  decisions: number;
};

/** Pure: counts from an overview, a look-alike count and a draft count. */
export function queueCountsOf(o: Pick<PayeeOverview, "groups" | "clusters">, lookalikes: number, drafts: number, suspicious: number): QueueCounts {
  const clusters = o.clusters.length;
  const unrecognized = o.groups.filter((g) => g.key && g.entityId == null && !g.bankOperation && !g.ownAccount && !g.channel).length;
  return {
    clusters,
    needsDecision: o.clusters.filter((c) => c.needsDecision).length,
    lookalikes,
    drafts,
    suspicious,
    unrecognized,
    decisions: clusters + lookalikes + drafts + suspicious,
  };
}

export const QUEUE_TTL_MS = 120_000;
const MAX_USERS = 50;
const cache = queueCache as Map<string, QueueCacheEntry<QueueCounts>>;
export { invalidatePayeeQueue };

export async function loadQueueCounts(opts: { executor: PayeeExecutor; userId: string; dek: Buffer | null; now?: number }): Promise<QueueCounts> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(opts.userId);
  if (hit && now - hit.at <= QUEUE_TTL_MS) return hit.counts;
  const overview = await loadPayeeOverview({ executor: opts.executor, userId: opts.userId, dek: opts.dek });
  const [lookalikes, drafts] = await Promise.all([
    loadLookalikes({ executor: opts.executor, userId: opts.userId, dek: opts.dek, overview }),
    opts.executor.execute(sql`SELECT count(*)::int AS n FROM payee_proposals WHERE user_id = ${opts.userId} AND status = 'draft'`),
  ]);
  const draftCount = Number((drafts as unknown as { rows?: Array<{ n: number }> }).rows?.[0]?.n ?? 0);
  const counts = queueCountsOf(overview, lookalikes.candidates.length, draftCount, suspiciousOf(overview).length);
  if (cache.size >= MAX_USERS && !cache.has(opts.userId)) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(opts.userId, { at: now, counts });
  return counts;
}
