/**
 * Payee Studio domain errors → HTTP responses for the /api/payees routes
 * (apiHandler `mapError`). Plain-language messages; 404 unknown id, 409
 * conflict / too large / undo blocked, 400 anything else.
 */
import { NextResponse } from "next/server";
import { PayeeBatchError } from "./batches";
import { PayeeDirectoryError } from "./directory";

const CONFLICT_CODES = new Set(["alias_conflict", "too_large", "newer_batch", "already_undone", "expired"]);

export function payeeErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof PayeeDirectoryError || error instanceof PayeeBatchError)) return null;
  const status = error.code === "not_found" ? 404 : CONFLICT_CODES.has(error.code) ? 409 : 400;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}
