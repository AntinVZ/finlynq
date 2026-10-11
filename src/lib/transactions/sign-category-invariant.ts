/**
 * Sign-vs-category advisory — issue #212 + FINLYNQ-97.
 *
 * For every transaction whose category is resolved to one of:
 *   - 'E' (expense)  → typical `amount` is ≤ 0 on asset/liability accounts
 *   - 'I' (income)   → typical `amount` is ≥ 0
 *   - 'R' (transfer) → exempt (sign convention varies per leg)
 *   - 'T' (legacy transfer alias minted by a separate broken `create_category`
 *          path — treated as transfer-exempt defensively until issue #12 lands
 *          and any 'T' rows are normalized to 'R'.)
 *
 * **FINLYNQ-97 (2026-05-23): this helper is now advisory, not a gate.** It
 * still returns a {@link SignCategoryMismatchError} when the (amount,
 * categoryType) pair disagrees, but callers DO NOT throw it or refuse the
 * row. Instead, every write transport surfaces the message through its own
 * warnings channel:
 *   - REST `/api/transactions` POST/PUT: top-level `warning` on the 200/201
 *     body.
 *   - HTTP MCP `record_transaction` / `update_transaction`: appended to
 *     `data.warnings[]` on the success envelope.
 *   - HTTP MCP `bulk_record_transactions`: appended to the per-row
 *     `results[i].warnings[]` (the row is `success: true`).
 *   - Stdio MCP `record_transaction` / `update_transaction`: appended to
 *     `data.warnings[]` (no DEK, message degrades to `category #<id>`).
 *   - Import pipeline: pushed into `importErrors[]` with a `"Warning: …"`
 *     prefix; the row materializes.
 *
 * Legitimate cases include refunds booked against the original expense
 * category (e.g. a $50 grocery refund as `+50` against Groceries) or
 * clawbacks on an income line.
 *
 * Uncategorized rows (`categoryId == null`, `categoryType == null`) are
 * exempt — those are typically receipt-OCR previews or "I'll fix this later"
 * rows and must remain insertable without category context.
 *
 * Bulk callers (bulk_record_transactions, import-pipeline) should fetch
 * {@link getCategoryTypeMap} once before the loop to avoid N round-trips.
 *
 * Stream D Phase 4: `categories.type` is plaintext and does NOT require a
 * DEK, so the helper works on every transport (HTTP MCP, stdio MCP, REST,
 * import). When a DEK is available the warning message includes the
 * decrypted category name; without a DEK (stdio) it falls back to
 * `category #<id>`.
 */

import { db, schema } from "@/db";
import { and, count, eq, inArray } from "drizzle-orm";
import { tryDecryptField } from "@/lib/crypto/envelope";

/** Possible values of `categories.type`. The DB column is plaintext text(),
 *  not enum-typed; we accept the string and normalize. */
export type CategoryTypeRaw = string | null | undefined;

export class SignCategoryMismatchError extends Error {
  code = "sign_category_mismatch" as const;
  constructor(
    public amount: number,
    public categoryName: string,
    public categoryType: "E" | "I",
  ) {
    const direction = categoryType === "E" ? "non-positive (≤ 0)" : "non-negative (≥ 0)";
    const role = categoryType === "E" ? "expense" : "income";
    super(
      `Category "${categoryName}" is type '${categoryType}' (${role}), so amount must be ${direction}; got ${amount}. Flip the sign or pick a different category.`,
    );
    this.name = "SignCategoryMismatchError";
  }
}

/**
 * Pure, synchronous advisory check. Returns a {@link SignCategoryMismatchError}
 * when the (amount, categoryType) pair disagrees, or `null` when the row
 * is OK / exempt.
 *
 * FINLYNQ-97: the error shape is preserved so callers can read `.message`,
 * but no caller throws it anymore. Each transport surfaces the message
 * through its own warnings channel — see the file header for the full
 * surface map.
 *
 * Caller responsibility:
 *   - resolve the category id → type (via `categories.type`)
 *   - resolve the category id → display name (decrypt `name_ct` when DEK
 *     is available; pass `"category #<id>"` when not)
 *   - append the returned `.message` to the response's warnings channel.
 */
export function validateSignVsCategory(args: {
  amount: number;
  categoryType: CategoryTypeRaw;
  categoryName: string;
}): SignCategoryMismatchError | null {
  if (!args.categoryType) return null; // uncategorized exempt
  // Defensively treat both 'R' (canonical transfer) and 'T' (legacy alias —
  // see file header) as transfer-exempt. amount=0 is also exempt because it
  // satisfies BOTH ≤ 0 and ≥ 0 (and many in-kind / RSU-vest patterns book
  // amount=0 with a quantity).
  if (args.categoryType === "R" || args.categoryType === "T") return null;
  if (args.amount === 0) return null;
  if (args.categoryType === "E" && args.amount > 0) {
    return new SignCategoryMismatchError(args.amount, args.categoryName, "E");
  }
  if (args.categoryType === "I" && args.amount < 0) {
    return new SignCategoryMismatchError(args.amount, args.categoryName, "I");
  }
  // Any other value of `categoryType` (typo, future-added enum value) is
  // accepted to avoid false positives.
  return null;
}

/**
 * Resolve a category id to {type, name} for the validator, then call the
 * pure helper. Returns the same error object (or null) on the same shape.
 *
 * - Selects only `id, type, name_ct` (DEK not required to read `type`).
 * - When the id is null / not found / not owned, returns `null` (exempt).
 *   Ownership is checked by the caller (route / MCP) earlier — this helper
 *   only validates the sign rule.
 */
export async function validateSignVsCategoryById(
  userId: string,
  dek: Buffer | null,
  categoryId: number | null | undefined,
  amount: number,
): Promise<SignCategoryMismatchError | null> {
  if (categoryId == null) return null;
  const row = await db
    .select({
      id: schema.categories.id,
      type: schema.categories.type,
      nameCt: schema.categories.nameCt,
    })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.id, categoryId),
        eq(schema.categories.userId, userId),
      ),
    )
    .get();
  if (!row) return null;
  const categoryName =
    (row.nameCt && dek
      ? tryDecryptField(dek, row.nameCt, "categories.name_ct")
      : null) ?? `category #${row.id}`;
  return validateSignVsCategory({
    amount,
    categoryType: row.type,
    categoryName,
  });
}

/**
 * Bulk variant — pre-fetch the (id → {type, name}) map once. Use this from
 * import-pipeline / bulk_record_transactions where N rows reference up to
 * N distinct category ids; one SELECT-IN beats N round-trips.
 *
 * Pass the user's DEK (or null) so the map's `name` is decrypted when
 * possible. Without a DEK every name falls back to `category #<id>`.
 */
export async function getCategoryTypeMap(
  userId: string,
  dek: Buffer | null,
  categoryIds?: Iterable<number | null | undefined>,
): Promise<Map<number, { type: string; name: string }>> {
  const ids = new Set<number>();
  if (categoryIds) {
    for (const id of categoryIds) {
      if (id != null && Number.isFinite(id)) ids.add(Number(id));
    }
  }
  // No ids supplied → return an empty map; caller can fall back to the
  // single-id helper for any row whose category isn't in the map.
  if (ids.size === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: schema.categories.id,
      type: schema.categories.type,
      nameCt: schema.categories.nameCt,
    })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.userId, userId),
        inArray(schema.categories.id, [...ids]),
      ),
    )
    .all();
  const out = new Map<number, { type: string; name: string }>();
  for (const r of rows) {
    const name =
      (r.nameCt && dek
        ? tryDecryptField(dek, r.nameCt, "categories.name_ct")
        : null) ?? `category #${r.id}`;
    out.set(Number(r.id), { type: String(r.type ?? ""), name });
  }
  return out;
}

/**
 * Settings → Categorization: may this category's `type` change?
 *
 * Every row already booked against a category was signed for its CURRENT type
 * (≤ 0 for 'E', ≥ 0 for 'I', anything for 'R'). Flipping the type would turn
 * those rows into retroactive {@link validateSignVsCategory} mismatches and
 * move them between the income / expense / transfer totals, so a type change
 * is only allowed while nothing references the category: zero transactions
 * and zero transaction splits (splits carry their own amount + category).
 * The user can merge the category into one of the right type instead.
 *
 * Returns `null` when the change is allowed (same type, unknown/foreign id —
 * the update itself is owner-scoped — or no booked rows), otherwise the
 * counts and a user-facing message.
 */
export async function getCategoryTypeChangeBlock(
  userId: string,
  categoryId: number,
  nextType: string,
): Promise<{ currentType: string; transactions: number; splits: number; message: string } | null> {
  const row = await db
    .select({ type: schema.categories.type })
    .from(schema.categories)
    .where(and(eq(schema.categories.id, categoryId), eq(schema.categories.userId, userId)))
    .get();
  if (!row || row.type === nextType) return null;
  const txRow = await db
    .select({ n: count() })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.userId, userId), eq(schema.transactions.categoryId, categoryId)))
    .get();
  const splitRow = await db
    .select({ n: count() })
    .from(schema.transactionSplits)
    .innerJoin(schema.transactions, eq(schema.transactions.id, schema.transactionSplits.transactionId))
    .where(and(eq(schema.transactions.userId, userId), eq(schema.transactionSplits.categoryId, categoryId)))
    .get();
  const transactions = Number(txRow?.n ?? 0);
  const splits = Number(splitRow?.n ?? 0);
  if (transactions === 0 && splits === 0) return null;
  const parts = [
    transactions ? `${transactions} transaction${transactions === 1 ? "" : "s"}` : null,
    splits ? `${splits} split${splits === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" and ");
  return {
    currentType: String(row.type),
    transactions,
    splits,
    message: `This category's type can't change while ${parts} use it — their signs were booked for the current type. Merge it into a category of the other type instead.`,
  };
}
