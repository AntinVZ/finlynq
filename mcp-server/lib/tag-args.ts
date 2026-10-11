/**
 * Zod shapes for tag arguments shared by the MCP tools (bulk edits, the
 * tag filters on search / bulk / reports, manage_tags). Values are whole tags,
 * compared with `normalizeForMatch` (lib/tags.ts) — never substrings.
 */
import { z } from "zod";

/** One tag, a comma-separated list, or an array of tags. */
export const tagListArg = z.union([z.string(), z.array(z.string())]);

/** `true` / `false`, also accepted as the strings "true" / "false". */
export const boolishArg = z.union([z.boolean(), z.enum(["true", "false"])]);

/**
 * The four multi-tag filter params, spread into a tool's input schema (search
 * and reports) or a filter object (bulk). Plain-language descriptions with an
 * example, since an assistant reads them to pick the right one.
 */
export const tagFilterArgs = {
  tags_all: tagListArg.optional().describe(
    "Only transactions that carry EVERY one of these tags. Whole tags, any letter case. One tag, a comma list or an array, e.g. [\"trip-2024\", \"Lviv\"].",
  ),
  tags_any: tagListArg.optional().describe(
    "Only transactions that carry AT LEAST ONE of these tags. Whole tags, any letter case, e.g. \"work,clients\".",
  ),
  tags_none: tagListArg.optional().describe(
    "Leave out transactions that carry ANY of these tags. Whole tags (`work` does not exclude `homework`), e.g. \"reimbursed\".",
  ),
  untagged: boolishArg.optional().describe(
    "true = only transactions with no tags at all. false or omitted = no tag requirement.",
  ),
};

export type TagFilterArgs = {
  tags_all?: string | string[];
  tags_any?: string | string[];
  tags_none?: string | string[];
  untagged?: boolean | "true" | "false";
};
