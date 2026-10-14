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
import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { apiHandler } from "@/lib/api-handler";
import { applyPayeeImportAssist } from "@/lib/payees/import-assist";

export const dynamic = "force-dynamic";

const handle = (write: boolean) =>
  apiHandler(
    { auth: "encryption", raw: true, fallbackMessage: "Couldn't read the payees of this import" },
    async ({ request, userId, dek }) => {
      const parts = request.nextUrl.pathname.split("/").filter(Boolean);
      const id = decodeURIComponent(parts[parts.length - 2] ?? "");
      const staged = await db
        .select({ id: schema.stagedImports.id, status: schema.stagedImports.status })
        .from(schema.stagedImports)
        .where(and(eq(schema.stagedImports.id, id), eq(schema.stagedImports.userId, userId)))
        .get();
      if (!staged) return NextResponse.json({ error: "Not found" }, { status: 404 });
      if (write && staged.status !== "pending") {
        return NextResponse.json({ error: "Staged import is not pending — edits are no longer accepted" }, { status: 409 });
      }
      const r = await applyPayeeImportAssist({ executor: db, userId, dek: dek!, stagedImportId: id, readOnly: !write });
      return NextResponse.json({ summary: r.summary, batchIds: r.batchIds });
    },
  );

export const GET = handle(false);
export const POST = handle(true);
