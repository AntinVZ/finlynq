/**
 * /api/settings/lot-allocation — the user's cost-basis method.
 *
 *   GET → { enabled, positions, withoutLots, mismatched }
 *   PUT { enabled: boolean } → the same, plus `rebuilt` (positions that had no
 *        lots and were built while turning it on)
 *
 * `enabled: false` (the default) is the simple average of every purchase.
 * `enabled: true` is advanced lot allocation: cost basis and gains come from
 * the lots still held, and each sale's matching can be changed. All rules live
 * in lots/allocation-mode.ts, shared with MCP `manage_lots(op:"set_mode")`.
 */

import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import {
  getLotAllocationStatus,
  setLotAllocationEnabled,
} from "@/lib/portfolio/lots/allocation-mode";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId }) => getLotAllocationStatus(userId));

export const PUT = apiHandler(
  { auth: "auth", body: z.object({ enabled: z.boolean() }) },
  async ({ userId, dek, body }) => setLotAllocationEnabled(userId, dek, body.enabled),
);
