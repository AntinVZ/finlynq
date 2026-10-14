/**
 * /api/payees/[id]/logo — a directory entry's logo as an image (P5c), for
 * the avatars in lists. PNG / JPEG / WebP only (validated on save, re-checked
 * here); 404 when the entry has no logo. Private, short browser cache.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { normalizeDbRows } from "@/lib/db-utils";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { decodeLogo } from "@/lib/payees/profile";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load logo" }, async ({ request, userId, dek }) => {
  const parts = request.nextUrl.pathname.split("/").filter(Boolean);
  const id = Number(parts[parts.length - 2]);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Bad entity id" }, { status: 400 });
  const rows = normalizeDbRows<{ logo: unknown }>(await db.execute(sql`SELECT logo FROM payee_entities WHERE id = ${id} AND user_id = ${userId}`));
  const stored = rows[0]?.logo == null ? null : String(rows[0].logo);
  const plain = stored && dek ? tryDecryptField(dek, stored, "payee-logo") : null;
  const logo = plain ? decodeLogo(plain) : null;
  if (!logo) return NextResponse.json({ error: "No logo" }, { status: 404 });
  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: { "Content-Type": logo.type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
});
