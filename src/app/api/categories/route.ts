import { NextRequest, NextResponse } from "next/server";
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getTransactionCountsByCategory,
} from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import {
  buildNameFields,
  decryptNamedRows,
  decryptOptional,
  encryptOptional,
} from "@/lib/crypto/encrypted-columns";
import { db } from "@/db";
import { isPgErrorCode, pgErrorConstraint } from "@/lib/db-utils";
import {
  getCategoryDeleteBlockers,
  categoryDeleteBlockedMessage,
} from "@/lib/categories/delete-blockers";
import { categoryTypeSchema } from "@/lib/categories/category-type";
import { getCategoryTypeChangeBlock } from "@/lib/transactions/sign-category-invariant";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";

/**
 * Category names are unique per user via the `categories_user_name_lookup_uniq`
 * index over the name_lookup HMAC. Renaming onto an existing name is ordinary
 * user behaviour, not a server fault — without this it escaped as a raw 23505
 * and the user got an opaque 500 (prod 2026-07-24 20:25 UTC).
 */
function duplicateNameResponse(error: unknown): NextResponse | null {
  if (!isPgErrorCode(error, "23505")) return null;
  const constraint = pgErrorConstraint(error);
  if (constraint && constraint !== "categories_user_name_lookup_uniq") return null;
  return NextResponse.json(
    { error: "You already have a category with that name. Pick a different name." },
    { status: 409 },
  );
}

// `type` was a bare z.string(), so a caller sending "expense" stored a category
// every report skips (they filter on the literal "E"). categoryTypeSchema maps
// the word forms to the code and 400s anything else.
const postSchema = z.object({
  name: z.string(),
  type: categoryTypeSchema,
  group: z.string(),
  note: z.string().optional(),
});

const putSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  type: categoryTypeSchema.optional(),
  group: z.string().optional(),
  note: z.string().optional(),
});

// `categories.note` is a user-DEK envelope column (user-encrypted-registry);
// MCP already writes it encrypted. Reads tolerate legacy plaintext.
function decryptNotes<T extends { note?: string | null }>(rows: T[], dek: Buffer | null): T[] {
  return rows.map((r) => (r.note ? { ...r, note: decryptOptional(dek, r.note) ?? r.note } : r));
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const { userId, dek } = auth.context;
    const rows = await getCategories(userId);
    const data = decryptNotes(decryptNamedRows(rows, dek, { nameCt: "name" }), dek);
    // Optional `withCounts=1` adds `txCount` (transactions per category) for
    // Settings → Categorization. Without it the response is unchanged.
    if (request.nextUrl.searchParams.get("withCounts") === "1") {
      const counts = await getTransactionCountsByCategory(userId);
      return NextResponse.json(data.map((c) => ({ ...c, txCount: counts.get(Number(c.id)) ?? 0 })));
    }
    return NextResponse.json(data);
  } catch (error: unknown) {
    await logApiError("GET", "/api/categories", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to load categories") }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // requireEncryption, not requireAuth: buildNameFields(null) returns {}, so a
  // DEK-less create persisted a permanently nameless category, and a DEK-less
  // rename silently no-opped while reporting success (review 2026-07-30 #7).
  const auth = await requireEncryption(request); if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const enc = buildNameFields(dek, { name: parsed.data.name });
    const note = parsed.data.note === undefined ? {} : { note: encryptOptional(dek, parsed.data.note) ?? "" };
    const category = await createCategory(userId, { ...parsed.data, ...note, ...enc });
    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    const duplicate = duplicateNameResponse(error);
    if (duplicate) return duplicate;
    await logApiError("POST", "/api/categories", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create category") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireEncryption(request); if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;
    // A type flip would retroactively mis-sign every booked row, so it is
    // only allowed while nothing uses the category.
    if (data.type !== undefined) {
      const block = await getCategoryTypeChangeBlock(userId, id, data.type);
      if (block) return NextResponse.json({ error: block.message, code: "category_in_use" }, { status: 409 });
    }
    if (data.note !== undefined) data.note = encryptOptional(dek, data.note) ?? "";
    if (data.group !== undefined) data.group = data.group.trim();
    const toEncrypt: Record<string, string | null | undefined> = {};
    if ("name" in data && data.name !== undefined) toEncrypt.name = data.name;
    const enc = buildNameFields(dek, toEncrypt);
    const category = await updateCategory(id, userId, { ...data, ...enc });
    // Name / group / type show on decrypted transaction reads.
    invalidateUserTxCache(userId);
    return NextResponse.json(category);
  } catch (error: unknown) {
    const duplicate = duplicateNameResponse(error);
    if (duplicate) return duplicate;
    await logApiError("PUT", "/api/categories", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update category") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    // Counts every ON DELETE NO ACTION referent, not just transactions — a
    // category attached to a budget used to escape as a raw 23503 from this
    // handler, which had no try/catch at all.
    const blockers = await getCategoryDeleteBlockers(db, auth.context.userId, id);
    if (blockers.length > 0) {
      return NextResponse.json({ error: categoryDeleteBlockedMessage(blockers) }, { status: 409 });
    }

    await deleteCategory(id, auth.context.userId);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    await logApiError("DELETE", "/api/categories", error, auth.context.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete category") },
      { status: 500 },
    );
  }
}
