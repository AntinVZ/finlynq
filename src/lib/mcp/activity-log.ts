/**
 * MCP activity journal (Settings → Integrations "AI & API access").
 *
 * One row in `mcp_activity_log` per MCP `tools/call`, written from a single
 * point: {@link instrumentCallTool} wraps the SDK's `tools/call` request
 * handler in src/app/api/mcp/route.ts, so every tool — legacy `server.tool`
 * and consolidated `manage_*` alike — is logged the same way.
 *
 * WHAT IS STORED: the client label, the tool name, its `op` (when the tool
 * takes one), whether the call is a write, whether it succeeded, an error
 * code and an affected-row count when the result reports one. Tool ARGUMENTS
 * and anything decrypted are NEVER stored; `op` is read from the arguments
 * only when it is a short [a-z_] identifier.
 *
 * FIRE-AND-FORGET: the insert is not awaited and every failure (DB down,
 * table missing before the migration ran, a bug here) is swallowed. Logging
 * never changes a tool call's result, latency or error.
 *
 * Retention: 90 days, src/lib/cron/sweep-mcp-activity-log.ts.
 */
import { sql } from "drizzle-orm";
import { mcpToolIsReadOnly } from "@/lib/oauth-scopes";

// ─── is_write ───────────────────────────────────────────────────────────────
//
// A call is a write when ALL of these hold:
//   1. The tool can write at all: NOT `mcpToolIsReadOnly(tool)` — the same
//      read-prefix list (get_ / list_ / search_ / preview_ / test_ / …) that
//      decides what an `mcp:read` OAuth token may call.
//   2. Its `op` (consolidated `manage_*` / `reconcile` tools) is not a read
//      op: list / get / list_rows / list_anchors / find_duplicates / suggest
//      read, every other op (create, update, delete, rename, merge, add, set,
//      record, apply_rules, buy, sell, …) writes. A write-capable tool with
//      no `op` (record_transaction, bulk_record_transactions, execute_bulk_*,
//      add_snapshot, reconcile without op, …) counts as a write.
//   3. The result is not a two-step PREVIEW. withConfirmation's first leg
//      (no `confirmation_token`) answers `{ preview: true, confirmationToken }`
//      and writes nothing, so it is logged as a read.
export const MCP_READ_OPS: ReadonlySet<string> = new Set([
  "list",
  "get",
  "list_rows",
  "list_anchors",
  "find_duplicates",
  "suggest",
  "preview",
  "status",
  "help",
  // manage_payees (Payee Studio) read ops.
  "clusters",
  "batches",
  "review",
  "proposals",
  "insights",
  "explain",
  "lookalikes",
  "dictionary_export",
]);

/** `op` as a safe label, or null (never echoes free text from the arguments). */
export function extractOp(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const op = (args as Record<string, unknown>).op;
  return typeof op === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(op) ? op : null;
}

/** Write intent from tool + op (rules 1 and 2 above). */
export function isWriteCall(tool: string, op: string | null): boolean {
  if (mcpToolIsReadOnly(tool)) return false;
  if (op && MCP_READ_OPS.has(op)) return false;
  return true;
}

// ─── outcome ────────────────────────────────────────────────────────────────

export type CallOutcome = {
  ok: boolean;
  errorCode: string | null;
  affectedCount: number | null;
  isPreview: boolean;
};

/** Count fields a success payload may carry, in priority order. */
const AFFECTED_KEYS = ["affected", "changed", "updated", "deleted", "created", "inserted", "imported", "count"] as const;

function firstText(result: unknown): string | null {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first && first.type === "text" && typeof first.text === "string" ? first.text : null;
}

/**
 * Read the outcome from a tool result without keeping any of it: `isError`
 * or the `err()` convention (`"Error: …"` text) → not ok; a JSON
 * `{ success: false }` → not ok; a JSON preview → isPreview; a top-level or
 * `data.` numeric count → affectedCount.
 */
export function summarizeToolResult(result: unknown): CallOutcome {
  const out: CallOutcome = { ok: true, errorCode: null, affectedCount: null, isPreview: false };
  const r = result as { isError?: unknown } | null | undefined;
  const text = firstText(result);
  if (r?.isError === true) {
    out.ok = false;
    out.errorCode = "tool_error";
  } else if (text != null && text.startsWith("Error:")) {
    out.ok = false;
    out.errorCode = "tool_error";
  }
  if (text == null || text.length > 2_000_000) return out;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return out;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return out;
  }
  if (parsed.success === false) {
    out.ok = false;
    const code = (parsed.code ?? (parsed.error as { code?: unknown } | undefined)?.code) as unknown;
    out.errorCode = typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : "tool_error";
  }
  const data = (parsed.data && typeof parsed.data === "object" ? parsed.data : parsed) as Record<string, unknown>;
  if (data.preview === true || parsed.preview === true || typeof data.confirmationToken === "string") {
    out.isPreview = true;
  }
  for (const key of AFFECTED_KEYS) {
    const v = data[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2_147_483_647) {
      out.affectedCount = Math.trunc(v);
      break;
    }
  }
  return out;
}

/** Error code for a thrown handler error: a short SQLSTATE / code, else "exception". */
export function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : "exception";
}

// ─── client label ──────────────────────────────────────────────────────────

export type McpClientRef =
  | { kind: "oauth"; clientId: string | null }
  | { kind: "api_key" }
  | { kind: "session" };

export const API_KEY_CLIENT_LABEL = "API key";
export const SESSION_CLIENT_LABEL = "Browser session";

// ─── writer ────────────────────────────────────────────────────────────────

export type ActivityEntry = {
  userId: string;
  client: McpClientRef;
  tool: string;
  op: string | null;
  isWrite: boolean;
  ok: boolean;
  errorCode: string | null;
  affectedCount: number | null;
};

type Executor = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * Insert one journal row, fire-and-forget. The OAuth client's display name is
 * resolved inside the INSERT (falls back to the client id, then "OAuth app"),
 * so the tool call never waits on it. Never throws, never rejects.
 */
export function logMcpActivity(db: Executor, e: ActivityEntry): void {
  try {
    const client =
      e.client.kind === "oauth"
        ? sql`COALESCE((SELECT client_name FROM oauth_clients WHERE client_id = ${e.client.clientId ?? ""} LIMIT 1), ${e.client.clientId ?? "OAuth app"})`
        : sql`${e.client.kind === "api_key" ? API_KEY_CLIENT_LABEL : SESSION_CLIENT_LABEL}`;
    void Promise.resolve()
      .then(() =>
        db.execute(sql`
          INSERT INTO mcp_activity_log (user_id, client, tool, op, is_write, ok, error_code, affected_count)
          VALUES (${e.userId}, ${client}, ${e.tool.slice(0, 100)}, ${e.op}, ${e.isWrite}, ${e.ok}, ${e.errorCode}, ${e.affectedCount})
        `),
      )
      .catch(() => {});
  } catch {
    // Logging must never affect the call.
  }
}

// ─── the single instrumentation point ──────────────────────────────────────

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;
type HandlerMap = Map<string, Handler>;

/**
 * Wrap the server's `tools/call` handler so every call is journaled after it
 * settles. The result (or thrown error) is passed through untouched.
 * Returns false when there is no handler to wrap (no tools registered).
 */
export const CALL_TOOL_METHOD = "tools/call";

export function instrumentCallTool(
  requestHandlers: HandlerMap,
  ctx: { db: Executor; userId: string; client: McpClientRef },
): boolean {
  const original = requestHandlers.get(CALL_TOOL_METHOD);
  if (!original) return false;
  requestHandlers.set(CALL_TOOL_METHOD, async (req: unknown, extra: unknown) => {
    const params = (req as { params?: { name?: unknown; arguments?: unknown } })?.params ?? {};
    const tool = typeof params.name === "string" ? params.name : "unknown";
    const op = extractOp(params.arguments);
    let result: unknown;
    try {
      result = await original(req, extra);
    } catch (error) {
      try {
        logMcpActivity(ctx.db, {
          userId: ctx.userId,
          client: ctx.client,
          tool,
          op,
          isWrite: isWriteCall(tool, op),
          ok: false,
          errorCode: errorCodeOf(error),
          affectedCount: null,
        });
      } catch {
        // ignore
      }
      throw error;
    }
    try {
      const outcome = summarizeToolResult(result);
      const isWrite = isWriteCall(tool, op) && !outcome.isPreview;
      logMcpActivity(ctx.db, {
        userId: ctx.userId,
        client: ctx.client,
        tool,
        op,
        isWrite,
        ok: outcome.ok,
        errorCode: outcome.errorCode,
        // A read's "count" is a result size, not rows affected.
        affectedCount: isWrite ? outcome.affectedCount : null,
      });
    } catch {
      // ignore
    }
    return result;
  });
  return true;
}
