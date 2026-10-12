/**
 * Pure query-param builder for the `/transactions` page (FINLYNQ-111 Phase 1).
 *
 * Extracted verbatim (byte-for-byte equivalent) from the inline block that used
 * to live inside `loadTxns` in `src/app/(app)/transactions/page.tsx` (lines
 * 786-856 pre-refactor). This function is PURE — no React, no fetch — so it can
 * be unit-tested against golden query strings that pin the exact behaviour the
 * GET `/api/transactions` route handler expects.
 *
 * The output `URLSearchParams` must remain byte-identical to the original
 * inline code: same keys, same conditionals, same ordering, same
 * `accountType`→account-ids resolution, and the load-bearing rule that the
 * `date` column filter only sets `startDate`/`endDate` when the top-bar quick
 * filter has NOT already set them.
 *
 * Do NOT "improve" anything here — behaviour preservation is the whole point.
 */

import type { ColumnId, SortableColumnId } from "@/lib/transactions/columns";
import { BUSINESS_PARAM, serializeBusinessFilter, type BusinessFilter } from "@/lib/reports/business-filter";

/** Top-bar quick filters (URL-driven). Mirrors the page `filters` state. */
export type TxFilters = {
  startDate?: string;
  endDate?: string;
  accountId?: string;
  categoryId?: string;
  search?: string;
  /** Payee Studio P5g: a requisite (IBAN / card in any form / ІПН / ЄДРПОУ). */
  identifier?: string;
  portfolioHolding?: string;
  tag?: string;
  // Multi-tag filter (whole tags; comma lists). `untagged` is "true" or empty.
  tags_all?: string;
  tags_any?: string;
  tags_none?: string;
  untagged?: string;
  // FINLYNQ-177 — first-class single-transaction deep link. `id=<n>` filters
  // the page to exactly one transaction (owner-scoped SQL pushdown on the GET
  // route). Distinct from the DELETE handler's `id` param (different HTTP
  // method, never routed through this builder). The string is kept as-is and
  // parsed to an int server-side.
  id?: string;
  // Business / personal scope (lib/reports/business-filter.ts). "all" or
  // absent sends nothing, so existing URLs are unchanged.
  business?: BusinessFilter;
};

/** Per-user header sort. `null` direction = unsorted (server default date DESC). */
export type TxSortPref = {
  columnId: SortableColumnId | null;
  direction: "asc" | "desc" | null;
};

/**
 * Per-column filter (issue #59). Discriminated union by column type; mirrors
 * the `ColFilterShape` on the page + the server-side zod schema.
 */
export type TxColFilter =
  | { type: "date"; columnId: ColumnId; from?: string; to?: string }
  | { type: "text"; columnId: ColumnId; value: string }
  | { type: "numeric"; columnId: ColumnId; op: "eq" | "gt" | "lt" | "between"; value: number; value2?: number }
  | { type: "enum"; columnId: ColumnId; values: string[] };

/**
 * Minimal account shape needed to resolve the `accountType` enum filter into
 * account ids. Takes `accounts` as an explicit argument (resolved 2026-06-03)
 * so the function stays pure.
 */
export type TxQueryAccount = { id: number; type?: string | null };

/** Pagination — `page` is 0-indexed, the offset is `page * limit`. */
export type TxQueryPage = { page: number; limit: number };

/**
 * Build the `URLSearchParams` for a GET `/api/transactions` request.
 *
 * Byte-identical to the original inline builder. See module docstring.
 */
export function buildTransactionQuery(
  filters: TxFilters,
  sort: TxSortPref,
  colFilters: TxColFilter[],
  accounts: TxQueryAccount[],
  page: TxQueryPage,
): URLSearchParams {
  const params = new URLSearchParams();
  // FINLYNQ-177 — single-transaction id deep link. Emitted FIRST so the deep
  // link reads as `?id=<n>` up front; the GET route applies it as an
  // owner-scoped `WHERE transactions.id = ?` pushdown.
  if (filters.id) params.set("id", filters.id);
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (filters.accountId) params.set("accountId", filters.accountId);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.search) params.set("search", filters.search);
  if (filters.identifier) params.set("identifier", filters.identifier);
  if (filters.portfolioHolding) params.set("portfolioHolding", filters.portfolioHolding);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.tags_all) params.set("tags_all", filters.tags_all);
  if (filters.tags_any) params.set("tags_any", filters.tags_any);
  if (filters.tags_none) params.set("tags_none", filters.tags_none);
  if (filters.untagged === "true") params.set("untagged", "true");
  const business = filters.business ? serializeBusinessFilter(filters.business) : null;
  if (business) params.set(BUSINESS_PARAM, business);

  // Issue #59 — sort + per-column filters. The top-bar quick filters
  // above are URL-driven (deep links from /portfolio etc. must keep
  // working); per-column filters are persisted server-side. Pushed as
  // a union — both sets narrow the result.
  if (sort.columnId && sort.direction) {
    params.set("sort", sort.columnId);
    params.set("sortDir", sort.direction);
  }
  for (const f of colFilters) {
    if (f.type === "date") {
      // Map column id → query param prefix that the route handler
      // recognizes. `date` reuses the existing startDate/endDate;
      // `createdAt`/`updatedAt` use their own pair.
      if (f.columnId === "date") {
        // Only set if the top-bar quick filter hasn't already.
        if (!params.has("startDate") && f.from) params.set("startDate", f.from);
        if (!params.has("endDate") && f.to) params.set("endDate", f.to);
      } else if (f.columnId === "createdAt") {
        if (f.from) params.set("createdAtFrom", f.from);
        if (f.to) params.set("createdAtTo", f.to);
      } else if (f.columnId === "updatedAt") {
        if (f.from) params.set("updatedAtFrom", f.from);
        if (f.to) params.set("updatedAtTo", f.to);
      }
    } else if (f.type === "text") {
      // Encrypted-column substring filter — uses the post-decrypt path.
      params.set(`filter_${f.columnId}`, f.value);
    } else if (f.type === "numeric") {
      const prefix = f.columnId === "amount" ? "amount" : f.columnId === "quantity" ? "quantity" : null;
      if (!prefix) continue;
      if (f.op === "eq") {
        params.set(`${prefix}Eq`, String(f.value));
      } else if (f.op === "gt") {
        params.set(`${prefix}Min`, String(f.value));
      } else if (f.op === "lt") {
        params.set(`${prefix}Max`, String(f.value));
      } else if (f.op === "between") {
        params.set(`${prefix}Min`, String(f.value));
        if (f.value2 != null) params.set(`${prefix}Max`, String(f.value2));
      }
    } else if (f.type === "enum") {
      if (f.columnId === "source") {
        params.set("sources", f.values.join(","));
      } else if (f.columnId === "category") {
        params.set("categoryIds", f.values.join(","));
      } else if (f.columnId === "account" || f.columnId === "accountType") {
        // accountType doesn't have a SQL pushdown — it's part of the
        // account JOIN. Push the ids of accounts of that type instead.
        if (f.columnId === "accountType") {
          const ids = accounts
            .filter((a) => a.type && f.values.includes(a.type))
            .map((a) => a.id);
          if (ids.length > 0) params.set("accountIds", ids.join(","));
        } else {
          params.set("accountIds", f.values.join(","));
        }
      }
    }
  }

  params.set("limit", String(page.limit));
  params.set("offset", String(page.page * page.limit));

  return params;
}
