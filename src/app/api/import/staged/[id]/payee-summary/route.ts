/**
 * /api/import/staged/[id]/payee-summary — what happens to an import's payees
 * (P8 stage 10), in the input order: requisite → exact alias → other alias →
 * merchant type → queue; channels, own transfers and bank operations apart.
 *
 *   GET  → the summary, read only (an email import is staged without the
 *          key, so its rows got no hint; this is where the person sees them).
 *   POST → run the import hint / autopilot now (as set in Merchants →
 *          Settings; each change is one undoable payee batch) and return
 *          the summary with what was renamed. Pending imports only.
 *
 * `import_hash` is never recomputed; bank-statement rows are not touched.
 */
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { applyPayeeImportAssist } from "@/lib/payees/import-assist";

export const dynamic = "force-dynamic";

async function handle(request: NextRequest, params: Promise<{ id: string }>, write: boolean) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;
  const staged = await db
    .select({ id: schema.stagedImports.id, status: schema.stagedImports.status })
    .from(schema.stagedImports)
    .where(and(eq(schema.stagedImports.id, id), eq(schema.stagedImports.userId, userId)))
    .get();
  if (!staged) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (write && staged.status !== "pending") {
    return NextResponse.json({ error: "Staged import is not pending — edits are no longer accepted" }, { status: 409 });
  }
  try {
    const r = await applyPayeeImportAssist({ executor: db, userId, dek, stagedImportId: id, readOnly: !write });
    return NextResponse.json({ summary: r.summary, batchIds: r.batchIds });
  } catch (err) {
    console.error("[payee-summary] failed", { stagedImportId: id, err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Couldn't read the payees of this import" }, { status: 500 });
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, false);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, true);
}
