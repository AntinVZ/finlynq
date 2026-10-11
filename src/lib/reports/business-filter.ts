/**
 * Business / personal scoping for reports (web Reports page + MCP reads).
 *
 * Three states, one wire format shared by `GET /api/reports`,
 * `GET /api/reports/trends` and the MCP `get_income_statement` /
 * `get_spending_trends` tools:
 *
 *   business=true   → only rows flagged business      (is_business = 1)
 *   business=false  → only personal rows              (is_business = 0)
 *   business=all    → no filter (also: absent, blank, or anything else)
 *
 * BACKWARD COMPATIBLE. Before this module the routes read
 * `business === "true"` and treated every other value as "all"; that reading
 * is preserved exactly — `true` still means business-only, and an absent or
 * unrecognised value still means every row. Only `false` is new.
 *
 * NULL IS PERSONAL. `transactions.is_business` is nullable with a column
 * default of 0, so a NULL is a row nobody flagged. Treating it as personal
 * (`COALESCE(is_business, 0) = 0`) keeps the invariant that the Business and
 * Personal views add up to the All view; a bare `= 0` would silently drop
 * NULL rows from both halves.
 *
 * Like account-filter.ts this module is pure and client-safe (the Reports
 * page imports it); the SQL fragment lives in business-filter-sql.ts so
 * drizzle stays out of the client bundle. Every caller already ANDs
 * `user_id = <user>` into the same WHERE.
 */

/** Query-string key every report endpoint reads. */
export const BUSINESS_PARAM = "business";

export type BusinessFilter = "all" | "business" | "personal";

/**
 * Parse the wire value (`true` | `false` | `all`) into a filter. Accepts a
 * real boolean too, because MCP clients routinely send `business: true`
 * rather than the string. Anything unrecognised degrades to "all" — the same
 * end state as not filtering, never an empty report.
 */
export function parseBusinessParam(value: string | boolean | null | undefined): BusinessFilter {
  if (value === true) return "business";
  if (value === false) return "personal";
  if (typeof value !== "string") return "all";
  const v = value.trim().toLowerCase();
  if (v === "true") return "business";
  if (v === "false") return "personal";
  return "all";
}

/**
 * Query-string value for a filter, or `null` when the param should be
 * omitted entirely ("all" is the default, so it never needs to be sent).
 */
export function serializeBusinessFilter(filter: BusinessFilter): string | null {
  if (filter === "business") return "true";
  if (filter === "personal") return "false";
  return null;
}
