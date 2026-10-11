/**
 * Shared confirmation-token middleware for destructive / high-volume MCP tools
 * (FINLYNQ-264, child B of the MCP-surface-v4 epic).
 *
 * The token CRYPTO already lives, finished and security-reviewed, in
 * `src/lib/mcp/confirmation-token.ts` (HMAC-SHA256, 5-min TTL, single-use
 * `jti` replay defense, userId+operation+payload binding). THIS module does
 * NOT reinvent the crypto — it extracts the *wiring* that every destructive
 * tool used to hand-roll ("if no token → build summary + sign; else → verify
 * + branch") into ONE place.
 *
 * **Single-call-site invariant (tc-2):** this file is the ONLY module in
 * `mcp-server/` that imports `@/lib/mcp/confirmation-token`, and
 * `signConfirmationToken` is called in exactly ONE spot below (inside
 * `signPreviewToken`). Every tool routes through:
 *   - `withConfirmation(userId, spec)` — the convention-(S) single-tool,
 *     optional-`confirmation_token` two-step HOF (preview ↔ commit); OR
 *   - `signPreviewToken` / `verifyPreviewToken` — the thin pass-throughs the
 *     convention-(P) `preview_* → execute_*` pairs use (they need a distinct
 *     preview tool that returns an affected-row SAMPLE, so they can't collapse
 *     into the HOF, but they still go through this one module for the crypto).
 *
 * Grep proof (HTTP surface): `grep -rn 'signConfirmationToken(' mcp-server/tools/`
 * → exactly one call site (in `signPreviewToken`). The stdio surface
 * (`register-core-tools.ts`, a separate transport that imports the crypto with
 * `.js` ESM specifiers and can't cross into this HTTP module) is out of scope
 * for B per the plan §11.
 */
import {
  signConfirmationToken,
  verifyConfirmationToken,
  type ConfirmationVerifyResult,
} from "../../src/lib/mcp/confirmation-token";
import { dataResponse, err } from "./_shared";
import { normalizeForMatch } from "../../src/lib/text-normalize";

/** MCP text-content tool result shape (what every handler returns). */
export type ToolResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Thrown by a `preview` builder to abort the two-step with a clean tool error
 * (e.g. the target row doesn't exist / isn't owned) INSTEAD of minting a token.
 * `withConfirmation` catches it and returns `err(message)` with NO writes and
 * NO token — preserving the pre-B "Not found → no token" surface.
 */
export class PreviewAbortError extends Error {}

/**
 * Sign a preview/confirmation token binding `userId + operation + payload`.
 * The SOLE call site of the underlying crypto `signConfirmationToken`.
 * Convention-(P) preview handlers (`preview_bulk_*`, `preview_delete_category`,
 * `detect_subscriptions`) call this; convention-(S) `withConfirmation` calls it
 * internally.
 */
export function signPreviewToken(
  userId: string,
  operation: string,
  payload: unknown,
): string {
  return signConfirmationToken(userId, operation, payload);
}

/**
 * Verify a confirmation token against the exact `userId + operation + payload`
 * it was signed for. Thin pass-through so no tool file imports the raw crypto.
 */
export function verifyPreviewToken(
  token: string,
  userId: string,
  operation: string,
  payload: unknown,
): ConfirmationVerifyResult {
  return verifyConfirmationToken(token, userId, operation, payload);
}

/**
 * Render a failed token verification into a human-readable error string.
 *
 * Special-cases `no_token` (FINLYNQ-274): a zero-match preview mints NO token,
 * so an empty/absent `confirmation_token` on execute should tell the agent to
 * run preview first — NOT that its token was `malformed` (which reads like a
 * serialization bug). All other reasons keep the "invalid: <reason>, re-run
 * preview" phrasing.
 *
 * `refreshHint` names the preview tool to re-run (e.g. "preview_bulk_delete").
 */
export function renderTokenError(
  check: ConfirmationVerifyResult,
  refreshHint: string,
): string {
  if (check.reason === "no_token") {
    return `no_token: run ${refreshHint} first (a zero-match preview mints no token).`;
  }
  return `Confirmation token invalid: ${check.reason}. Re-run ${refreshHint}.`;
}

/** The human-readable preview summary — any JSON-serializable value. */
export type PreviewSummary = unknown;

/**
 * `expected_summary` echo gate (FINLYNQ-264 tier-2). Cheaper than a token
 * round-trip: the caller passes what it BELIEVES it's deleting; a mismatch
 * against the loaded row is refused. Defends the hallucinated-id threat (agent
 * deletes #812 thinking it's Starbucks when it's rent) with a pure comparison,
 * no state, no round-trip.
 *
 * Returns `null` when the echo passes (or was omitted — echo is OPTIONAL /
 * non-breaking), or a human-readable mismatch message when it fails.
 *
 * `payee` is compared case-insensitively + trimmed; `amount` within a $0.01
 * epsilon (float-safe). A field the caller DIDN'T assert is not checked.
 */
export function checkExpectedEcho(
  expected: { payee?: string; amount?: number } | undefined,
  actual: { payee?: string | null; amount?: number | null },
  label: string,
): string | null {
  if (!expected) return null;
  if (expected.payee != null) {
    const want = normalizeForMatch(expected.payee);
    const got = normalizeForMatch(String(actual.payee ?? ""));
    if (want !== got) {
      return `Refusing to delete ${label}: you said payee "${expected.payee}", but it is "${actual.payee ?? ""}". Re-check the id.`;
    }
  }
  if (expected.amount != null) {
    const got = Number(actual.amount ?? NaN);
    if (!Number.isFinite(got) || Math.abs(got - expected.amount) > 0.01) {
      return `Refusing to delete ${label}: you said amount ${expected.amount}, but it is ${actual.amount ?? "?"}. Re-check the id.`;
    }
  }
  return null;
}

export interface ConfirmSpec<A extends { confirmation_token?: string }> {
  /**
   * Operation label bound into the token (e.g. "delete_transfer"). MUST be
   * unique per logical operation so a token minted for one op can't commit
   * another (operation-mismatch is one of the crypto's defenses).
   */
  operation: string;
  /**
   * The IDENTITY that must not change between preview and commit. MUST include
   * the resolved row id(s) — the token binds to a hash of this, so a token
   * issued for row X can't commit a delete of row Y (payload-mismatch).
   */
  tokenPayload: (args: A) => unknown;
  /** READ-ONLY: builds the human-readable preview summary. MUST NOT mutate. */
  preview: (args: A) => Promise<PreviewSummary> | PreviewSummary;
  /** The actual destructive body (lifted verbatim from the pre-B handler). */
  commit: (args: A) => Promise<ToolResult>;
  /**
   * When present and it returns FALSE, the gate is skipped and `commit` runs
   * directly (the clean / empty-entity case — e.g. deleting an account with no
   * transactions or a holding with no lots). Omit to ALWAYS gate.
   */
  required?: (args: A) => Promise<boolean> | boolean;
}

/**
 * Turn a `{ preview, commit }` spec into a single two-step MCP handler
 * (convention S). The returned handler:
 *   - runs `commit` directly when `required()` says the gate isn't needed;
 *   - otherwise, with NO `confirmation_token`, runs the read-only `preview` and
 *     returns `{ preview: true, summary, confirmationToken }` (NO writes);
 *   - with a `confirmation_token`, verifies it and — only if valid — runs the
 *     existing destructive `commit` body.
 *
 * The response shape on the COMMIT path is whatever `commit` returns, byte for
 * byte — so a tool that gains this gate keeps its existing success shape.
 */
export function withConfirmation<A extends { confirmation_token?: string }>(
  userId: string,
  spec: ConfirmSpec<A>,
): (args: A) => Promise<ToolResult> {
  return async (args: A): Promise<ToolResult> => {
    // A PreviewAbortError thrown from ANY of the resolution helpers below
    // (required / preview / tokenPayload) surfaces a clean tool error and
    // mints NO token — preserving the pre-B "resolution failed → err()"
    // surface (row not found, ambiguous, DEK-refusal, mismatch).
    try {
      // Clean-case predicate: when required() is false, no token is needed.
      if (spec.required) {
        const gateOn = await spec.required(args);
        if (!gateOn) return spec.commit(args);
      }

      const payload = spec.tokenPayload(args);

      // ── Preview branch (no writes) ───────────────────────────────────────
      if (!args.confirmation_token) {
        const summary = await spec.preview(args);
        const token = signPreviewToken(userId, spec.operation, payload);
        return dataResponse({ preview: true, summary, confirmationToken: token });
      }

      // ── Commit branch ────────────────────────────────────────────────────
      const check = verifyPreviewToken(
        args.confirmation_token,
        userId,
        spec.operation,
        payload,
      );
      if (!check.valid) {
        // `no_token` can't occur on the convention-(S) path (an absent token
        // routes to the preview branch above), but map it defensively so the
        // taxonomy is consistent everywhere.
        if (check.reason === "no_token") {
          return err(
            `no_token: re-call ${spec.operation} without confirmation_token to get a fresh preview + token.`,
          );
        }
        return err(
          `Confirmation token invalid: ${check.reason}. Re-call without confirmation_token to refresh.`,
        );
      }
      return spec.commit(args);
    } catch (e) {
      if (e instanceof PreviewAbortError) return err(e.message);
      throw e;
    }
  };
}
