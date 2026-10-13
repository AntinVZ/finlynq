/**
 * The per-user cache of the Merchants queue counts (./queue.ts). No imports,
 * so every write path (suggest, proposals) can drop it without a cycle.
 */
export type QueueCacheEntry<T> = { at: number; counts: T };

const g = globalThis as unknown as { __pfPayeeQueue?: Map<string, QueueCacheEntry<unknown>> };
export const queueCache = (g.__pfPayeeQueue ??= new Map());

const o = globalThis as unknown as { __pfPayeeOverviewCards?: Map<string, QueueCacheEntry<unknown>> };
/** P8 stage 2: the overview cards, keyed `${userId}:${period}`. */
export const overviewCache = (o.__pfPayeeOverviewCards ??= new Map());

/** Drop a user's queue counts and overview cards (after a directory change, a payee rewrite or an AI proposal). */
export function invalidatePayeeQueue(userId: string): void {
  queueCache.delete(userId);
  for (const k of [...overviewCache.keys()]) if (k.startsWith(`${userId}:`)) overviewCache.delete(k);
}
