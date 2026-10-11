/**
 * Background sweep for the MCP activity journal (Settings → Integrations).
 *
 * Deletes `mcp_activity_log` rows older than 90 days so the journal stays
 * short. Daily interval, fire-and-forget, idempotent. Wired in
 * `instrumentation-node.ts` next to the other sweeps.
 */

import { db, schema } from "@/db";
import { lt } from "drizzle-orm";

export const MCP_ACTIVITY_RETENTION_DAYS = 90;

export type SweepResult = { deleted: number };

/** Delete journal rows older than the retention window. Errors bubble to the caller. */
export async function sweepMcpActivityLog(now: number = Date.now()): Promise<SweepResult> {
  const cutoff = new Date(now - MCP_ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(schema.mcpActivityLog)
    .where(lt(schema.mcpActivityLog.createdAt, cutoff))
    .returning({ id: schema.mcpActivityLog.id });
  return { deleted: deleted.length };
}

let timer: NodeJS.Timeout | null = null;

/** Start the daily sweep. Safe to call multiple times. */
export function startMcpActivityLogSweepTimer(): void {
  if (timer) return;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  timer = setInterval(() => {
    sweepMcpActivityLog().catch((err) => {
      console.error("[sweep-mcp-activity-log] sweep failed:", err);
    });
  }, ONE_DAY);
  if (timer.unref) timer.unref();
}

/** Stop the sweep interval. For tests. */
export function stopMcpActivityLogSweepTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
