/**
 * GET /api/settings/ai-access (Settings → Integrations, S3) and the 90-day
 * sweep. DB-free.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { renderSql } from "../helpers/tag-ledger";

let statements: Array<{ sql: string; params: unknown[] }> = [];
let missingTable = false;
const keyStatus = vi.fn();

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "userA", dek: null } })),
}));
vi.mock("@/lib/api-auth", () => ({ getApiKeyStatus: (...a: unknown[]) => keyStatus(...a) }));
vi.mock("@/db", () => ({
  db: {
    execute: async (q: SQL) => {
      const r = renderSql(q);
      statements.push(r);
      if (missingTable) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      if (/GROUP BY client/.test(r.sql)) {
        return { rows: [
          { client: "Claude", last_at: "2026-10-11T10:00:00Z", calls_7d: "12", writes_7d: "3" },
          { client: "API key", last_at: "2026-10-10T09:00:00Z", calls_7d: "1", writes_7d: "0" },
        ] };
      }
      return { rows: [
        { id: 7, client: "Claude", tool: "manage_tags", op: "rename", is_write: true, ok: true, error_code: null, affected_count: 4, created_at: "2026-10-11T10:00:00Z" },
      ] };
    },
  },
}));

import { GET } from "@/app/api/settings/ai-access/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

beforeEach(() => {
  statements = [];
  missingTable = false;
  keyStatus.mockResolvedValue({ exists: true, createdAt: "2026-09-01T00:00:00.000Z", hasDekWrap: true });
});

describe("GET /api/settings/ai-access", () => {
  it("returns key status, per-client summary and the newest events", async () => {
    const { status, data } = await parseResponse(await GET(createMockRequest("http://localhost:3000/api/settings/ai-access")));
    expect(status).toBe(200);
    expect(data).toMatchObject({
      apiKey: { exists: true, createdAt: "2026-09-01T00:00:00.000Z", lastActivityAt: "2026-10-10T09:00:00.000Z" },
      clients: [{ client: "Claude", calls7d: 12, writes7d: 3 }, { client: "API key", calls7d: 1 }],
      events: [{ id: 7, tool: "manage_tags", op: "rename", isWrite: true, ok: true, affectedCount: 4 }],
      journalAvailable: true,
    });
    for (const s of statements) expect(s.params[0]).toBe("userA");
    expect(statements[1].sql).toMatch(/LIMIT \$2/);
    expect(statements[1].params[1]).toBe(100);
    expect(statements[1].sql).not.toMatch(/AND is_write/);
  });

  it("writesOnly=1 filters events to writes", async () => {
    await GET(createMockRequest("http://localhost:3000/api/settings/ai-access?writesOnly=1"));
    expect(statements[1].sql).toMatch(/AND is_write/);
  });

  it("before the migration: key card still works, journal marked unavailable", async () => {
    missingTable = true;
    const { status, data } = await parseResponse(await GET(createMockRequest("http://localhost:3000/api/settings/ai-access")));
    expect(status).toBe(200);
    expect(data).toMatchObject({ journalAvailable: false, events: [], clients: [], apiKey: { exists: true, lastActivityAt: null } });
  });
});
