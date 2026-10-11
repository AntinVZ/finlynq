/**
 * Server-side half of business-filter.ts: the WHERE fragment. Kept apart so
 * the client Reports page can import the parser without pulling in drizzle.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { BusinessFilter } from "./business-filter";

/**
 * WHERE fragment for the filter, or `null` for "all". `column` is the
 * `is_business` column — a drizzle column (`schema.transactions.isBusiness`)
 * or a raw `sql\`t.is_business\`` for the MCP raw-SQL queries.
 */
export function businessFilterCondition(filter: BusinessFilter, column: SQLWrapper): SQL | null {
  if (filter === "business") return sql`${column} = 1`;
  if (filter === "personal") return sql`COALESCE(${column}, 0) = 0`;
  return null;
}
