/**
 * GET /api/settings/ai-access — Settings → Integrations "AI & API access".
 *
 *   → {
 *       apiKey: { exists, createdAt, hasDekWrap, lastActivityAt },
 *       clients: [{ client, lastActivityAt, calls7d, writes7d }],
 *       events: [{ id, client, tool, op, isWrite, ok, errorCode, affectedCount, createdAt }],
 *       journalAvailable,
 *     }
 *
 * Optional `?writesOnly=1` limits `events` to writes. `events` is the newest
 * 100 rows of the MCP activity journal (90-day retention); `clients` sums
 * the last 7 days per client label. Reading the API-key status never creates
 * a key (unlike GET /api/settings/api-key). `apiKey.lastActivityAt` is the
 * last MCP call made with the key.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { getApiKeyStatus } from "@/lib/api-auth";
import { isPgErrorCode, normalizeDbRows } from "@/lib/db-utils";
import { safeErrorMessage, logApiError } from "@/lib/validate";
import { API_KEY_CLIENT_LABEL } from "@/lib/mcp/activity-log";

const EVENTS_LIMIT = 100;

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const writesOnly = request.nextUrl.searchParams.get("writesOnly") === "1";
  try {
    const keyStatus = await getApiKeyStatus(userId);

    let journalAvailable = true;
    let clients: Array<{ client: string; lastActivityAt: string | null; calls7d: number; writes7d: number }> = [];
    let events: Array<Record<string, unknown>> = [];
    try {
      const clientRows = normalizeDbRows<Record<string, unknown>>(
        await db.execute(sql`
          SELECT client,
                 MAX(created_at) AS last_at,
                 COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS calls_7d,
                 COUNT(*) FILTER (WHERE is_write AND created_at > now() - interval '7 days') AS writes_7d
            FROM mcp_activity_log
           WHERE user_id = ${userId}
           GROUP BY client
           ORDER BY MAX(created_at) DESC
        `),
      );
      clients = clientRows.map((r) => ({
        client: String(r.client),
        lastActivityAt: iso(r.last_at),
        calls7d: Number(r.calls_7d ?? 0),
        writes7d: Number(r.writes_7d ?? 0),
      }));
      const eventRows = normalizeDbRows<Record<string, unknown>>(
        await db.execute(sql`
          SELECT id, client, tool, op, is_write, ok, error_code, affected_count, created_at
            FROM mcp_activity_log
           WHERE user_id = ${userId}
             ${writesOnly ? sql`AND is_write` : sql``}
           ORDER BY created_at DESC, id DESC
           LIMIT ${EVENTS_LIMIT}
        `),
      );
      events = eventRows.map((r) => ({
        id: Number(r.id),
        client: String(r.client),
        tool: String(r.tool),
        op: r.op == null ? null : String(r.op),
        isWrite: r.is_write === true || r.is_write === "t",
        ok: r.ok === true || r.ok === "t",
        errorCode: r.error_code == null ? null : String(r.error_code),
        affectedCount: r.affected_count == null ? null : Number(r.affected_count),
        createdAt: iso(r.created_at),
      }));
    } catch (error) {
      // Table not there yet (migration not applied): show the key card anyway.
      if (!isPgErrorCode(error, "42P01")) throw error;
      journalAvailable = false;
    }

    return NextResponse.json({
      apiKey: {
        ...keyStatus,
        lastActivityAt: clients.find((c) => c.client === API_KEY_CLIENT_LABEL)?.lastActivityAt ?? null,
      },
      clients,
      events,
      writesOnly,
      journalAvailable,
    });
  } catch (error) {
    await logApiError("GET", "/api/settings/ai-access", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to load AI & API access") }, { status: 500 });
  }
}
