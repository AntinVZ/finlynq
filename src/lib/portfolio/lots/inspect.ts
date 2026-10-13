/**
 * Reading one holding's lots and the closures that consumed them. SERVER ONLY.
 *
 * The single source for the web Lot inspector
 * (`GET /api/portfolio/holdings/[holdingId]/lots`) and MCP
 * `manage_lots(op:"list")`, so an assistant sees exactly what the screen shows.
 * No DEK needed: lot and closure rows carry no encrypted fields. Every query is
 * scoped by `userId`.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";

export type InspectedLot = {
  id: number;
  accountId: number;
  openTxId: number;
  openDate: string;
  side: "long" | "short";
  origin: string;
  status: string;
  qtyOriginal: number;
  qtyRemaining: number;
  costPerShare: number;
  currency: string;
};

export type InspectedClosure = {
  id: number;
  lotId: number;
  closeTxId: number;
  closeDate: string;
  qtyClosed: number;
  proceedsPerShare: number;
  costPerShare: number;
  realizedGain: number;
  currency: string;
  closeKind: string;
  /**
   * The lot opened AFTER this closure's date. The fingerprint of an
   * out-of-order import (a sell recorded before its buy); a rebuild fixes it.
   */
  openAfterClose: boolean;
};

/** Every lot of a holding (open, closed, transferred out) with its closures, oldest first. */
export async function loadHoldingLotsAndClosures(
  userId: string,
  holdingId: number,
  accountId: number | null = null,
): Promise<{ lots: InspectedLot[]; closures: InspectedClosure[] }> {
  const lotConditions = [
    eq(schema.holdingLots.userId, userId),
    eq(schema.holdingLots.holdingId, holdingId),
  ];
  if (accountId != null) lotConditions.push(eq(schema.holdingLots.accountId, accountId));

  const lotRows = await db
    .select()
    .from(schema.holdingLots)
    .where(and(...lotConditions))
    .orderBy(asc(schema.holdingLots.openDate), asc(schema.holdingLots.id));

  const lots: InspectedLot[] = lotRows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    openTxId: r.openTxId,
    openDate: r.openDate,
    side: ((r as { side?: string | null }).side ?? "long") as "long" | "short",
    origin: r.origin,
    status: r.status,
    qtyOriginal: Number(r.qtyOriginal),
    qtyRemaining: Number(r.qtyRemaining),
    costPerShare: Number(r.costPerShare),
    currency: r.currency,
  }));

  // Closures for these lots only (scoped to the holding's lots).
  const lotIds = lots.map((l) => l.id);
  const closureRows =
    lotIds.length > 0
      ? await db
          .select()
          .from(schema.holdingLotClosures)
          .where(
            and(
              eq(schema.holdingLotClosures.userId, userId),
              inArray(schema.holdingLotClosures.lotId, lotIds),
            ),
          )
          .orderBy(asc(schema.holdingLotClosures.closeDate), asc(schema.holdingLotClosures.id))
      : [];

  const lotOpenDateById = new Map(lots.map((l) => [l.id, l.openDate]));
  const closures: InspectedClosure[] = closureRows.map((r) => {
    const lotOpenDate = lotOpenDateById.get(r.lotId) ?? null;
    return {
      id: r.id,
      lotId: r.lotId,
      closeTxId: r.closeTxId,
      closeDate: r.closeDate,
      qtyClosed: Number(r.qtyClosed),
      proceedsPerShare: Number(r.proceedsPerShare),
      costPerShare: Number(r.costPerShare),
      realizedGain: Number(r.realizedGain),
      currency: r.currency,
      closeKind: r.closeKind,
      openAfterClose: lotOpenDate != null && lotOpenDate > r.closeDate,
    };
  });

  return { lots, closures };
}

/**
 * The position a holding belongs to, as the lot engine scopes it: every
 * holding row that clusters under the same security within the same account
 * (a security can back more than one position row in an account). Null when
 * the holding is not the caller's or has no account.
 */
export async function resolvePositionScope(
  userId: string,
  holdingId: number,
): Promise<{ holdingIds: number[]; accountId: number } | null> {
  const holding = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      securityId: schema.portfolioHoldings.securityId,
    })
    .from(schema.portfolioHoldings)
    .where(and(eq(schema.portfolioHoldings.id, holdingId), eq(schema.portfolioHoldings.userId, userId)))
    .get();
  if (!holding || holding.accountId == null) return null;
  const accountId = holding.accountId;

  let holdingIds: number[] = [holdingId];
  if (holding.securityId != null) {
    const siblings = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, userId),
          eq(schema.portfolioHoldings.securityId, holding.securityId),
          eq(schema.portfolioHoldings.accountId, accountId),
        ),
      );
    holdingIds = [...new Set([holdingId, ...siblings.map((s) => s.id)])];
  }
  return { holdingIds, accountId };
}
