/**
 * manage_tags — list, rename, merge and delete transaction tags.
 *
 * Tags are the comma-separated, per-row encrypted `transactions.tags` text,
 * not a table, so every op reads and decrypts the user's tagged rows
 * (src/lib/transactions/tag-ops.ts — the same code Settings → Tags uses) and
 * writes through the shared batch writer (user-scoped, `updated_at = NOW()`,
 * unchanged rows untouched).
 *
 * rename / merge / delete are preview → confirm, like the bulk tools: a call
 * without `confirmation_token` returns the affected count and a token (5-min
 * TTL) bound to the exact rows; the same call with the token commits. More
 * than 10,000 affected rows, or a scan that stopped early (`truncated`), gets
 * no token, and a commit is refused.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type PgToolContext, dataResponse, err } from "./_shared";
import { signPreviewToken, verifyPreviewToken } from "./_confirm";
import { registerManageTool } from "./_consolidate";
import { invalidateUser as invalidateUserTxCache } from "../../src/lib/mcp/user-tx-cache";
import { parseBusinessParam } from "../../src/lib/reports/business-filter";
import { containsNormalized } from "../../src/lib/text-normalize";
import { tagKey, toTagList } from "../../src/lib/tags";
import {
  normalizeTagOp,
  planTagOp,
  runTagOp,
  scanTaggedRows,
  summarizeTags,
  TAG_OP_MAX_ROWS,
  type TagOp,
} from "../../src/lib/transactions/tag-ops";
import { tagListArg } from "../lib/tag-args";

const TOO_LARGE_NOTE =
  `This would change more than ${TAG_OP_MAX_ROWS.toLocaleString("en-US")} transactions, or the tag scan stopped early. No confirmation token was issued; split the change (e.g. merge fewer tags at a time).`;

export function registerTagsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;

  async function opList(input: { business?: boolean | string; search?: string; limit?: number }) {
    const scan = await scanTaggedRows({ executor: db, userId, dek, business: parseBusinessParam(input.business) });
    let tags = summarizeTags(scan.rows);
    if (input.search?.trim()) {
      const needle = input.search;
      tags = tags.filter((t) => t.spellings.some((s) => containsNormalized(s.spelling, needle)));
    }
    const total = tags.length;
    const limit = input.limit ?? 200;
    const notes: string[] = [];
    if (total > limit) notes.push(`Showing ${limit} of ${total} tags (most used first); raise \`limit\` or pass \`search\`.`);
    if (!dek) notes.push("No decryption key on this connection: only unencrypted (legacy) tags are listed.");
    return dataResponse({
      tags: tags.slice(0, limit).map((t) => ({
        tag: t.tag,
        count: t.count,
        firstDate: t.firstDate,
        lastDate: t.lastDate,
        hasVariants: t.hasVariants,
        spellings: t.spellings,
      })),
      total,
      scanned: scan.scanned,
      truncated: scan.truncated,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    });
  }

  async function opChange(raw: TagOp, token: string | undefined) {
    const norm = normalizeTagOp(raw);
    if (!norm.ok) return err(norm.error);
    const op = norm.op;
    const scan = await scanTaggedRows({ executor: db, userId, dek });
    const plan = planTagOp(op, scan);
    // The token binds the op (normalized keys) and the exact rows it changes.
    const payload = {
      op: op.op,
      from: op.op === "delete" ? op.tags.map(tagKey) : (op.op === "rename" ? [op.from] : op.from).map(tagKey),
      to: op.op === "delete" ? null : op.to,
      ids: plan.ids,
    };
    const blocked = plan.tooLarge || plan.truncated;

    if (!token) {
      const summary = {
        op: op.op,
        ...(op.op === "delete" ? { tags: op.tags } : { from: op.op === "rename" ? [op.from] : op.from, to: op.to }),
        affectedCount: plan.affected,
        truncated: blocked,
        ...(op.op !== "delete"
          ? {
              targetExists: plan.targetExists,
              ...(plan.targetExists
                ? { mergeNote: `"${op.to}" already exists on ${plan.targetCount} transaction(s); this merges into it.` }
                : {}),
            }
          : { deleteNote: "Only the tag is removed; the transactions stay." }),
      };
      if (plan.affected === 0) return dataResponse({ preview: true, ...summary, note: "No transactions carry these tags; nothing to confirm." });
      if (blocked) return dataResponse({ preview: true, ...summary, note: TOO_LARGE_NOTE });
      return dataResponse({ preview: true, ...summary, confirmationToken: signPreviewToken(userId, `manage_tags_${op.op}`, payload) });
    }

    if (blocked) return err(`Refusing to execute: ${TOO_LARGE_NOTE}`);
    const check = verifyPreviewToken(token, userId, `manage_tags_${op.op}`, payload);
    if (!check.valid) {
      return err(
        check.reason === "no_token"
          ? "no_token: call manage_tags without confirmation_token first to preview."
          : `Confirmation token invalid: ${check.reason}. Re-call without confirmation_token to refresh the preview.`,
      );
    }
    const res = await runTagOp({ executor: db, userId, dek, op, ids: plan.ids });
    if (res.changed > 0) invalidateUserTxCache(userId);
    return dataResponse({ op: op.op, changed: res.changed });
  }

  const tokenArg = z
    .string()
    .optional()
    .describe("Token from the preview call with the same arguments. Omit to preview; pass verbatim to commit. Single-use; 5-minute TTL.");

  registerManageTool(
    server,
    "manage_tags",
    "Manage transaction tags: `op` selects list / rename / merge / delete. list: every tag with its transaction count, first and last date, and the spellings it is stored under (`hasVariants` marks e.g. \"Acme\" and \"acme \"). rename / merge / delete are TWO-STEP: call without `confirmation_token` to preview how many transactions change and get a token, then repeat the same call with the token to commit. Renaming onto an existing tag merges them. Delete removes the tag only, never the transactions. Tags match whole and ignore letter case, so `work` never touches `homework`. Over 10,000 affected transactions → no token.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("list"),
        business: z.union([z.boolean(), z.enum(["true", "false", "all"])]).optional().describe("true = business transactions only, false = personal only, all = every transaction (default)."),
        search: z.string().optional().describe("Only tags whose name contains this text, e.g. \"trip\"."),
        limit: z.number().int().positive().max(5000).optional().describe("Most tags to return, most used first (default 200)."),
      }),
      z.object({
        op: z.literal("rename"),
        tag: z.string().describe("The tag to rename, any letter case, e.g. \"acme\"."),
        new_name: z.string().describe("The new name, e.g. \"Acme\". If that tag already exists, the two are merged."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("merge"),
        tags: tagListArg.describe("Tags to fold into `into`: one, a comma list or an array, e.g. [\"ac\", \"ac-trade\"]."),
        into: z.string().describe("The tag they become, e.g. \"Acme\". It may be new or already exist."),
        confirmation_token: tokenArg,
      }),
      z.object({
        op: z.literal("delete"),
        tags: tagListArg.describe("Tags to remove from every transaction: one, a comma list or an array, e.g. \"old-project\". The transactions stay."),
        confirmation_token: tokenArg,
      }),
    ]),
    async (input) => {
      try {
        if (input.op === "list") return await opList(input);
        if (input.op === "rename") return await opChange({ op: "rename", from: input.tag, to: input.new_name }, input.confirmation_token);
        if (input.op === "merge") return await opChange({ op: "merge", from: toTagList(input.tags), to: input.into }, input.confirmation_token);
        return await opChange({ op: "delete", tags: toTagList(input.tags) }, input.confirmation_token);
      } catch (e) {
        return err(String(e instanceof Error ? e.message : e));
      }
    },
  );
}
