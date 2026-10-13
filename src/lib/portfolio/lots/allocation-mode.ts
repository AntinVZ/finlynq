/**
 * The per-user choice between the two cost-basis methods (2026-10-13). SERVER
 * ONLY — reaches `db`.
 *
 *   Simple (default)         cost basis = the average price of EVERY purchase
 *                            in a holding, times the shares still held. Shares
 *                            already sold stay in that average.
 *   Advanced lot allocation  every purchase is its own lot and each sale is
 *                            matched to specific lots (first in, first out
 *                            unless the user changes it), so cost basis and
 *                            unrealized gain come only from shares still held.
 *
 * Lots are RECORDED for everyone on every trade either way. This switch only
 * decides whether the figures a user sees are computed from them. It is stored
 * in `portfolio_lots_status.enabled`, which until now only an operator could
 * set by hand.
 *
 * One write path (`setLotAllocationEnabled`) serves the settings screen and
 * MCP `manage_lots(op:"set_mode")`.
 */

import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { rebuildLotsForPosition } from "./backfill";
import { clearLotsEnabledCache, isLotsEnabledForUser } from "./read";
import { resolvePositionScope } from "./inspect";

export type LotAllocationStatus = {
  /** true = advanced lot allocation; false = the simple average. */
  enabled: boolean;
  /** Positions with at least one trade (cash excluded). */
  positions: number;
  /** Positions with trades but no lots at all. */
  withoutLots: number;
  /** Positions whose open lots do not add up to the shares held. */
  mismatched: number;
};

type CoverageRow = { holdingId: number; noLots: boolean; mismatch: boolean };

/**
 * For each non-cash position with trades: does it have lots, and do its open
 * lots add up to the shares held? A position that fails either check shows the
 * wrong cost basis under lot allocation until it is rebuilt.
 */
async function coverage(userId: string): Promise<CoverageRow[]> {
  const res = await db.execute(sql`
    WITH tx AS (
      SELECT portfolio_holding_id AS hid, SUM(quantity) AS qty
      FROM transactions
      WHERE user_id = ${userId}
        AND portfolio_holding_id IS NOT NULL
        AND quantity IS NOT NULL AND quantity <> 0
      GROUP BY 1
    ),
    lots AS (
      SELECT holding_id AS hid,
             COALESCE(SUM(CASE WHEN side = 'short' THEN -qty_remaining ELSE qty_remaining END)
                      FILTER (WHERE status = 'open'), 0) AS lot_qty,
             COUNT(*) AS lots
      FROM holding_lots
      WHERE user_id = ${userId}
      GROUP BY 1
    )
    SELECT tx.hid AS holding_id,
           (l.lots IS NULL) AS no_lots,
           (l.lots IS NOT NULL
             AND ABS(l.lot_qty - tx.qty) > GREATEST(0.0001, ABS(tx.qty) * 1e-4)) AS mismatch
    FROM tx
    JOIN portfolio_holdings ph
      ON ph.id = tx.hid AND ph.user_id = ${userId} AND COALESCE(ph.is_cash, FALSE) = FALSE
    LEFT JOIN lots l ON l.hid = tx.hid
  `);
  return normalizeDbRows<{ holding_id: number; no_lots: boolean; mismatch: boolean }>(res).map((r) => ({
    holdingId: Number(r.holding_id),
    noLots: r.no_lots === true,
    mismatch: r.mismatch === true,
  }));
}

function summarize(enabled: boolean, rows: CoverageRow[]): LotAllocationStatus {
  return {
    enabled,
    positions: rows.length,
    withoutLots: rows.filter((r) => r.noLots).length,
    mismatched: rows.filter((r) => r.mismatch).length,
  };
}

/** Which method the user is on, and how complete their lots are. */
export async function getLotAllocationStatus(userId: string): Promise<LotAllocationStatus> {
  const [enabled, rows] = await Promise.all([isLotsEnabledForUser(userId), coverage(userId)]);
  return summarize(enabled, rows);
}

/**
 * Switch a user between the two methods.
 *
 * Turning it ON first builds lots for every position that has none (trades
 * recorded before lots existed, or through a path that did not write them):
 * there is nothing to lose there, and without lots the position would have no
 * cost basis to show. Positions that already have lots are left exactly as
 * they are, because a rebuild resets any allocation the user chose by hand;
 * those that do not add up are reported in `mismatched` for the user to
 * rebuild from the Lot inspector.
 *
 * Turning it OFF changes only which figures are shown. Lots and any custom
 * allocation are kept, so switching back restores them.
 */
export async function setLotAllocationEnabled(
  userId: string,
  dek: Buffer | null,
  enabled: boolean,
): Promise<LotAllocationStatus & { rebuilt: number }> {
  let rebuilt = 0;
  if (enabled) {
    const done = new Set<number>();
    for (const row of (await coverage(userId)).filter((r) => r.noLots)) {
      if (done.has(row.holdingId)) continue;
      const scope = await resolvePositionScope(userId, row.holdingId);
      if (!scope) continue;
      await rebuildLotsForPosition(userId, dek, scope);
      for (const id of scope.holdingIds) done.add(id);
      rebuilt++;
    }
  }

  await db
    .insert(schema.portfolioLotsStatus)
    .values({ userId, enabled, notes: "Set by the user" })
    .onConflictDoUpdate({
      target: schema.portfolioLotsStatus.userId,
      set: { enabled },
    });
  // The flag is cached for 30s per process; without this the next page load
  // would still show the old method.
  clearLotsEnabledCache(userId);

  return { ...summarize(enabled, await coverage(userId)), rebuilt };
}
