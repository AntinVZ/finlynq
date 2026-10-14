/**
 * The version of the Merchants (`manage_payees`) MCP schema — ops, params and
 * answer shapes (P8 stage 9, B12). The server version in
 * `src/lib/mcp/tool-counts.ts` changes only with the tool list; this one
 * changes whenever an op or an answer field of `manage_payees` (or the
 * `payee_resolution` of transaction writes) changes, so Settings → AI & API
 * access shows which schema the connector answers with.
 *
 * History: p8.9 — ops `coverage`, `queue`; `cursor` / `compact` on list,
 * clusters, review with uniform `truncated` / `next_cursor`;
 * `payee_resolution` on manage_transactions record / update.
 */
export const PAYEE_MCP_SCHEMA_VERSION = "p8.9" as const;
