/**
 * /api/payees — Payee Studio overview (Settings → Payees).
 *
 * GET ?limit=N (default 5000)
 *   → { groups, clusters, currency, scanned, truncated, undecryptable, totalGroups }
 *   Every payee of the user, read from transactions, recurring, staged,
 *   SimpleFIN pending and the bank ledger (read only), decrypted and folded:
 *   `groups` are spellings with the same matching key (case, apostrophes,
 *   Latin/Cyrillic transliteration and card-terminal noise ignored);
 *   `clusters` reference groups by `keys` and carry a confidence, the
 *   reasons, and `needsDecision` for private persons / sole proprietors.
 *   `total` is the signed sum of the group's transactions in the display
 *   currency.
 *
 * Read only. Payees are encrypted per row, so everything happens in memory
 * after decryption (lib/payees) — no SQL text matching on payee.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { db } from "@/db";
import { safeErrorMessage, logApiError } from "@/lib/validate";
import { loadPayeeOverview } from "@/lib/payees/service";

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "");
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20_000) : 5_000;
    const overview = await loadPayeeOverview({ executor: db, userId, dek });
    return NextResponse.json({
      groups: overview.groups.slice(0, limit).map(({ slices: _slices, ...g }) => g),
      totalGroups: overview.groups.length,
      clusters: overview.clusters.map(({ groups: _groups, ...c }) => c),
      currency: overview.currency,
      scanned: overview.scanned,
      truncated: overview.truncated,
      undecryptable: overview.undecryptable,
    });
  } catch (error) {
    await logApiError("GET", "/api/payees", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to load payees") }, { status: 500 });
  }
}
