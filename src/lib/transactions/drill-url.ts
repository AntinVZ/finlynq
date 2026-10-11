/**
 * Single source of truth for the `/transactions?<params>` drill-through URL
 * shape (FINLYNQ-130).
 *
 * "Drill-through" = clicking a summary value anywhere in the app (dashboard
 * tiles, budget rows, spending/income reports, Sankey segments, portfolio
 * holdings, ...) navigates to `/transactions` with the exact filters that
 * produced that value pre-applied. Every such link MUST build its href via
 * this helper so the URL shape stays consistent with what the transactions
 * page reads back (`urlParams.get(...)` in `transactions/page.tsx`) and what
 * `buildTransactionQuery` forwards to `GET /api/transactions`.
 *
 * Pure — no React, no fetch — so it can be unit-tested against golden strings.
 */

import type { TxFilters } from "@/lib/transactions/build-query";

/**
 * Build a drill-through URL into the transactions page.
 *
 * Appends each non-empty `TxFilters` value to a `URLSearchParams` (empty
 * strings / `undefined` / `null` are skipped so we never emit dangling
 * `&key=` pairs). Returns `/transactions` with no trailing `?` when no
 * filters are set.
 *
 * Keys are emitted in the caller's own insertion order (only recognised
 * `TxFilters` keys are honoured) — `URLSearchParams` handles the encoding.
 */
const ALLOWED_KEYS: ReadonlySet<keyof TxFilters> = new Set([
  "id",
  "startDate",
  "endDate",
  "accountId",
  "categoryId",
  "search",
  "portfolioHolding",
  "tag",
  "tags_all",
  "tags_any",
  "tags_none",
  "untagged",
]);

export function buildTxDrillUrl(filters: Partial<TxFilters>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (!ALLOWED_KEYS.has(key as keyof TxFilters)) continue;
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}
