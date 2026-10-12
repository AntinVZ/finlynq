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
 *   Each tag also carries `businessCount` / `personalCount` (NULL = personal).
 *   Optional `tree=1` adds `tree`: the "/" hierarchy (`колега/Шляхов` sits
 *   under `колега`) with per-node rollups counted over DISTINCT transactions
 *   (`count`, `businessCount`, `personalCount`, `total`, `tagCount`).
 *
 * POST { op: "rename", tag, newName } | { op: "merge", tags, into } |
 *      { op: "delete", tags } | { op: "rename_prefix", prefix, newPrefix } |
 *      { op: "normalize", tags? }, plus optional `dryRun: true`
 *   rename_prefix renames a branch: `prefix` and every `prefix/…` tag; its
 *   dry run adds `tagCount` and `collisions` (renamed tags that already exist,
 *   which merge). normalize rewrites tags stored under several spellings to
 *   the most used one (all such tags, or only `tags`); its dry run adds
 *   `tags: [{ tag, variants }]`.
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
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { BUSINESS_PARAM, parseBusinessParam } from "@/lib/reports/business-filter";
import { getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";
import {
  buildTagTree,
  normalizeTagOp,
  planNormalizeSpelling,
  planPrefixRename,
  planTagOp,
  runTagOp,
  runTagTransform,
  scanTaggedRows,
  summarizeTags,
  type TagSlice,
  TAG_OP_MAX_ROWS,
  type TagOp,
} from "@/lib/transactions/tag-ops";

export const GET = apiHandler({ auth: "encryption", raw: true, fallbackMessage: "Failed to load tags" }, async ({ request, userId, dek }) => {
  const business = parseBusinessParam(request.nextUrl.searchParams.get(BUSINESS_PARAM));
  const scan = await scanTaggedRows({ executor: db, userId, dek: dek!, business });
  const summaries = summarizeTags(scan.rows);
  const currency = await getDisplayCurrency(userId);
  const rateMap = await getRateMap(currency, userId);
  const toTotal = (slices: TagSlice[]) =>
    Math.round(slices.reduce((sum, s) => sum + convertReportingSlice(s, currency, rateMap), 0) * 100) / 100;
  const tags = summaries.map(({ slices, ...t }) => ({ ...t, total: toTotal(slices) }));
  const tree =
    request.nextUrl.searchParams.get("tree") === "1"
      ? buildTagTree(scan.rows).map(({ slices, ...n }) => ({ ...n, total: toTotal(slices) }))
      : undefined;
  return NextResponse.json({
    tags,
    ...(tree ? { tree } : {}),
    currency,
    business,
    scanned: scan.scanned,
    truncated: scan.truncated,
    ...(scan.undecryptable > 0 ? { undecryptable: scan.undecryptable } : {}),
  });
});

const tagName = z.string().max(200);
const tagNames = z.union([tagName, z.array(tagName).max(500)]);

const postSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename"), tag: tagName, newName: tagName, dryRun: z.boolean().optional() }),
  z.object({ op: z.literal("merge"), tags: tagNames, into: tagName, dryRun: z.boolean().optional() }),
  z.object({ op: z.literal("delete"), tags: tagNames, dryRun: z.boolean().optional() }),
  z.object({ op: z.literal("rename_prefix"), prefix: tagName, newPrefix: tagName, dryRun: z.boolean().optional() }),
  z.object({ op: z.literal("normalize"), tags: tagNames.optional(), dryRun: z.boolean().optional() }),
]);

const tooLargeError = () =>
  `This would change more transactions than one tag operation can safely cover (limit ${TAG_OP_MAX_ROWS.toLocaleString("en-US")}).`;

export const POST = apiHandler(
  { auth: "encryption", raw: true, body: postSchema, fallbackMessage: "Tag update failed" },
  async ({ userId, dek: maybeDek, body: input }) => {
    const dek = maybeDek!;

    // Branch rename and spelling cleanup reuse the scan + the shared batch
    // writer; only the per-row transform differs.
    if (input.op === "rename_prefix" || input.op === "normalize") {
      const scan = await scanTaggedRows({ executor: db, userId, dek });
      let transform: (tags: string) => string;
      let summary: Record<string, unknown> & { affected: number; tooLarge: boolean; truncated: boolean; ids?: number[] };
      if (input.op === "rename_prefix") {
        const planned = planPrefixRename(input.prefix, input.newPrefix, scan);
        if (!planned.ok) return NextResponse.json({ error: planned.error }, { status: 400 });
        transform = planned.transform;
        summary = planned.plan;
      } else {
        const only = input.tags === undefined ? undefined : typeof input.tags === "string" ? [input.tags] : input.tags;
        const planned = planNormalizeSpelling(scan, only);
        transform = planned.transform;
        summary = planned.plan;
      }
      const { ids = [], ...publicSummary } = summary;
      if (input.dryRun) return NextResponse.json(publicSummary);
      if (summary.tooLarge || summary.truncated) {
        return NextResponse.json({ ...publicSummary, error: tooLargeError(), code: "tag_op_too_large" }, { status: 409 });
      }
      const res = await runTagTransform({ executor: db, userId, dek, transform, ids });
      if (res.changed > 0) invalidateUserTxCache(userId);
      return NextResponse.json({ ...publicSummary, changed: res.changed });
    }

    const raw: TagOp =
      input.op === "rename"
        ? { op: "rename", from: input.tag, to: input.newName }
        : input.op === "merge"
          ? { op: "merge", from: typeof input.tags === "string" ? [input.tags] : input.tags, to: input.into }
          : { op: "delete", tags: typeof input.tags === "string" ? [input.tags] : input.tags };
    const norm = normalizeTagOp(raw);
    if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 });

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
      return NextResponse.json({ ...summary, error: tooLargeError(), code: "tag_op_too_large" }, { status: 409 });
    }
    const res = await runTagOp({ executor: db, userId, dek, op: norm.op, ids: plan.ids });
    if (res.changed > 0) invalidateUserTxCache(userId);
    return NextResponse.json({ ...summary, changed: res.changed });
  },
);
