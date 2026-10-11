-- mcp_activity_log — short per-user journal of MCP tool calls (Settings →
-- Integrations "AI & API access").
--
-- One row per MCP `tools/call`: which client made it (OAuth client name, or
-- "API key" / "Browser session"), the tool and its `op`, whether it is a write,
-- whether it succeeded, an optional error code and affected-row count. Tool
-- ARGUMENTS and any decrypted data are NEVER stored — only these labels.
--
-- Written fire-and-forget from src/lib/mcp/activity-log.ts (a failed insert
-- never breaks the tool call). Kept for 90 days by the daily sweep in
-- src/lib/cron/sweep-mcp-activity-log.ts. Deleted with the user's data in
-- deleteAllUserDataTx.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS mcp_activity_log (
  id              SERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  client          TEXT NOT NULL,
  tool            TEXT NOT NULL,
  op              TEXT,
  is_write        BOOLEAN NOT NULL DEFAULT false,
  ok              BOOLEAN NOT NULL DEFAULT true,
  error_code      TEXT,
  affected_count  INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_activity_log_user_created_idx
  ON mcp_activity_log (user_id, created_at DESC);

-- Retention sweep deletes by age across all users.
CREATE INDEX IF NOT EXISTS mcp_activity_log_created_idx
  ON mcp_activity_log (created_at);
