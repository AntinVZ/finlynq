/**
 * /api/tags — the user's transaction tags (Settings → Tags).
 *
 * GET  ?business=true|false|all (default all)
 *   → { tags: [{ tag, key, count, firstDate, lastDate, spellings, hasVariants,
 *       total }], currency, scanned, truncated }
 *   One entry per tag (identity `normalizeForMatch`): `tag` is the most used
 *   spelling, `hasVariants` flags a tag stored with several spellings
 *   ("Agrotrade" and "agrotrade "). `total` is the signed sum of the tagged
 *   transactions in the display currency, converted the way the dashboard
 *   converts flows (`convertReportingSlice`).
 *
 * POST { op: "rename", tag, newName } | { op: "merge", tags, into } |
 *      { op: "delete", tags }, plus optional `dryRun: true`
 *   dryRun → { affected, targetExists, targetCount, tooLarge, truncated }
 *   (what the confirm dialog shows). Without dryRun the op runs and returns
 *   { changed }. Renaming onto an existing tag merges the two; deleting a tag
 *   only removes it from transactions. More than 10,000 rows, or a scan that
 *   stopped early, is refused (409) — same ceiling as the bulk tools.
 *
 * Tags are encrypted per row, so both verbs read and decrypt the user's
 * tagged rows (lib/transactions/tag-ops.ts) and write through the shared
 * batch writer (user-scoped, `updated_at` bumped).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { db } from "@/db";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { BUSINESS_PARAM, parseBusinessParam } from "@/lib/reports/business-filter";
import { getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";
import {
  normalizeTagOp,
  planTagOp,
  runTagOp,
  scanTaggedRows,
  summarizeTags,
  TAG_OP_MAX_ROWS,
  type TagOp,
} from "@/lib/transactions/tag-ops";

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const business = parseBusinessParam(request.nextUrl.searchParams.get(BUSINESS_PARAM));
    const scan = await scanTaggedRows({ executor: db, userId, dek, business });
    const summaries = summarizeTags(scan.rows);
    const currency = await getDisplayCurrency(userId);
    const rateMap = await getRateMap(currency, userId);
    const tags = summaries.map(({ slices, ...t }) => ({
      ...t,
      total: Math.round(
        slices.reduce((sum, s) => sum + convertReportingSlice(s, currency, rateMap), 0) * 100,
      ) / 100,
    }));
    return NextResponse.json({
      tags,
      currency,
      business,
      scanned: scan.scanned,
      truncated: scan.truncated,
      ...(scan.undecryptable > 0 ? { undecryptable: scan.undecryptable } : {}),
    });
  } catch (error) {
    await logApiError("GET", "/api/tags", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to load tags") }, { status: 500 });
  }
}

const tagName = z.string().max(200);
const tagNames = z.union([tagName, z.array(tagName).max(500)]);

const postSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename"), tag: tagName, newName: tagName, dryRun: z.boolean().optional() }),
  z.object({ op: z.literal("merge"), tags: tagNames, into: tagName, dryRun: z.boolean().optional() }),
  z.object({ op: z.literal("delete"), tags: tagNames, dryRun: z.boolean().optional() }),
]);

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const body = await request.json().catch(() => null);
  const parsed = validateBody(body, postSchema);
  if (parsed.error) return parsed.error;
  const input = parsed.data;

  const raw: TagOp =
    input.op === "rename"
      ? { op: "rename", from: input.tag, to: input.newName }
      : input.op === "merge"
        ? { op: "merge", from: typeof input.tags === "string" ? [input.tags] : input.tags, to: input.into }
        : { op: "delete", tags: typeof input.tags === "string" ? [input.tags] : input.tags };
  const norm = normalizeTagOp(raw);
  if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });

  try {
    const scan = await scanTaggedRows({ executor: db, userId, dek });
    const plan = planTagOp(norm.op, scan);
    const summary = {
      affected: plan.affected,
      targetExists: plan.targetExists,
      targetCount: plan.targetCount,
      tooLarge: plan.tooLarge,
      truncated: plan.truncated,
    };
    if (input.dryRun) return NextResponse.json(summary);
    if (plan.tooLarge || plan.truncated) {
      return NextResponse.json(
        {
          ...summary,
          error: `This would change more transactions than one tag operation can safely cover (limit ${TAG_OP_MAX_ROWS.toLocaleString("en-US")}).`,
          code: "tag_op_too_large",
        },
        { status: 409 },
      );
    }
    const res = await runTagOp({ executor: db, userId, dek, op: norm.op, ids: plan.ids });
    if (res.changed > 0) invalidateUserTxCache(userId);
    return NextResponse.json({ ...summary, changed: res.changed });
  } catch (error) {
    await logApiError("POST", "/api/tags", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Tag update failed") }, { status: 500 });
  }
}
