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
