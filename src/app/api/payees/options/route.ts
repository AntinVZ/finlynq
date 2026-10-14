/**
 * /api/payees/options — the directory as pick lists (P8 stage 10): every
 * entry `{ id, name, merchantTypeId, defaultCategoryId }` and every stored
 * merchant type `{ id, group, name, code }`, for the rule editor's
 * `merchant` / `merchant_type` conditions. Read only.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadDirectory } from "@/lib/payees/directory";
import { loadMerchantTypes } from "@/lib/payees/merchant-types";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Failed to load merchants" }, async ({ userId, dek }) => {
  const [directory, types] = await Promise.all([loadDirectory(db, userId, dek), loadMerchantTypes(db, userId)]);
  return NextResponse.json({
    merchants: directory
      .map((e) => ({ id: e.id, name: e.name, type: e.type, merchantTypeId: e.merchantTypeId, defaultCategoryId: e.defaultCategoryId }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    types: types.filter((t) => t.id != null).map((t) => ({ id: t.id!, group: t.group, name: t.name, code: t.code ?? null, defaultCategoryId: t.defaultCategoryId })),
  });
});
