/**
 * Wording for a refused lot reassignment. Pure. Shared by the REST route
 * (`/api/portfolio/holdings/[holdingId]/lots/reassign`) and MCP
 * `manage_lots(op:"reassign")`, so both surfaces explain a refusal the same way.
 */

import type { ReassignError } from "./write-hooks";

export function reassignErrorMessage(err: ReassignError): string {
  switch (err.code) {
    case "close_tx_not_found":
      return "Closure transaction not found for this holding";
    case "no_closures":
      return "That transaction has no lot closures to reassign";
    case "not_reassignable":
      return `Only plain sell closures can be reassigned (this is '${err.closeKind}')`;
    case "qty_mismatch":
      return `The chosen quantities (${err.got}) must total the closure quantity (${err.expected})`;
    case "lot_not_in_scope":
      return `Lot #${err.lotId} is not in this holding/account — reassignment is same-account only`;
  }
}
