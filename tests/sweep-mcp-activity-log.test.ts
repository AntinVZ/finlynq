/** 90-day retention sweep for mcp_activity_log (S3). */
import { describe, it, expect, vi } from "vitest";

const where = vi.fn();
vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema-pg")>("@/db/schema-pg");
  return {
    schema,
    db: {
      delete: () => ({
        where: (cond: unknown) => {
          where(cond);
          return { returning: async () => [{ id: 1 }, { id: 2 }] };
        },
      }),
    },
  };
});

import { sweepMcpActivityLog, MCP_ACTIVITY_RETENTION_DAYS } from "@/lib/cron/sweep-mcp-activity-log";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

describe("sweepMcpActivityLog", () => {
  it("deletes rows older than 90 days", async () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    const res = await sweepMcpActivityLog(now);
    expect(res.deleted).toBe(2);
    expect(MCP_ACTIVITY_RETENTION_DAYS).toBe(90);
    const q = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(q.sql).toMatch(/"mcp_activity_log"\."created_at" < \$1/);
    expect(String(q.params[0])).toContain("2026-07-13");
  });
});
