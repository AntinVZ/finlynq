/**
 * GET /api/portfolio/holdings/[holdingId]/lots?accountId=<opt>
 *
 * FINLYNQ-176 — read-only lot inspector data. Returns every lot for a
 * holding (open / closed / transferred-out) and every closure that
 * consumes those lots, with the per-closure realized gain. Powers the
 * lot-inspector dialog so users can see how their lots are being consumed
 * (which sell/transfer landed on which lot, at what cost + proceeds).
 *
 * Distinct from the existing GET /api/portfolio/lots?holdingId=N (which
 * powers the SellForm LotPicker and returns lots only): this route also
 * returns the closures and is shaped for the inspector. Kept as a separate
 * endpoint so the picker's byte-stable contract is untouched.
 *
 * The query lives in `loadHoldingLotsAndClosures` (lots/inspect.ts), shared
 * with MCP `manage_lots(op:"list")` so an assistant sees what this screen shows.
 *
 * Auth: requireAuth — no DEK needed (lot + closure rows carry no encrypted
 * fields). Cross-tenant scoping enforced via the userId predicate.
 *
 * 200: {
 *   lots: Array<{ id, accountId, openTxId, openDate, side, origin, status,
 *                 qtyOriginal, qtyRemaining, costPerShare, currency }>,
 *   closures: Array<{ id, lotId, closeTxId, closeDate, qtyClosed,
 *                     proceedsPerShare, costPerShare, realizedGain,
 *                     currency, closeKind, openAfterClose }>,
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { logApiError, safeErrorMessage } from "@/lib/validate";
import { loadHoldingLotsAndClosures } from "@/lib/portfolio/lots/inspect";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ holdingId: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const { holdingId: holdingIdRaw } = await params;
    const holdingId = parseInt(holdingIdRaw, 10);
    if (!Number.isFinite(holdingId) || holdingId <= 0) {
      return NextResponse.json(
        { error: "holdingId must be a positive integer" },
        { status: 400 },
      );
    }
    const accountIdRaw = request.nextUrl.searchParams.get("accountId");
    const accountId =
      accountIdRaw && /^\d+$/.test(accountIdRaw)
        ? parseInt(accountIdRaw, 10)
        : null;

    return NextResponse.json(await loadHoldingLotsAndClosures(userId, holdingId, accountId));
  } catch (error) {
    await logApiError(
      "GET",
      "/api/portfolio/holdings/[holdingId]/lots",
      error,
      userId,
    );
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load lots") },
      { status: 500 },
    );
  }
}
