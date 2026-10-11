/**
 * MCP HTTP tool group: categories (FINLYNQ-109 extraction).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. The only edits
 * are the enclosing function wrapper + the shared-state destructure from ctx.
 * Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  text,
  err,
  resolveEntity,
  formatResolveFailure,
  decryptNameish,
  type Row,
  type PgToolContext,
} from "./_shared";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  encryptName,
  nameLookup,
} from "../../src/lib/crypto/encrypted-columns";
import {
  invalidateUser as invalidateUserTxCache,
} from "../../src/lib/mcp/user-tx-cache";
import {
  signPreviewToken,
  verifyPreviewToken,
  withConfirmation,
  PreviewAbortError,
} from "./_confirm";
import { registerManageTool } from "./_consolidate";
import {
  countCategoryDependents as countCategoryDependentsShared,
  mergeCategoryInto,
  totalCategoryDependents,
  type CategoryDependentCounts,
} from "../../src/lib/categories/merge";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerCategoriesTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek, encNote } = ctx;


  // ── op: delete (preview) — lifted VERBATIM from preview_delete_category ─────
  async function opDeletePreview(args: { id?: number; name?: string }): Promise<ToolResult> {
    const { id, name } = args;
    if (id == null && (name == null || name === "")) {
      return err("Pass exactly one of `id` (numeric) or `name` (fuzzy).");
    }
    // Resolve the category id. Same Stream-D-Phase-4 pattern as `delete_budget`.
    let cat: Row | null = null;
    if (id != null) {
      const rows = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId} AND id = ${id}`);
      if (!rows.length) return err(`Category #${id} not found.`);
      cat = decryptNameish(rows, dek)[0];
    } else {
      if (!dek) return err("Cannot resolve category by name without an unlocked DEK (Stream D Phase 4). Pass `id` instead.");
      const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
      const allCats = decryptNameish(rawCats, dek);
      // FINLYNQ-267: resolve via the shared envelope — a mistyped/unmatched name
      // is REFUSED and a 2+ match returns an ambiguous list (was `fuzzyFind`
      // silent-first). `id` above is the FK fast-path.
      // FINLYNQ-273: render the refusal via the shared formatter so category
      // not_found/ambiguous read IDENTICALLY to goals/holdings (candidates WITH
      // ids in both cases — was `suggestionList` names-only, no ids).
      const env = resolveEntity({ entity: "category", name, options: allCats });
      if (env.status !== "resolved") return err(formatResolveFailure("category", env)!);
      cat = allCats.find((c) => Number(c.id) === env.id) ?? null;
    }
    if (!cat) return err(`Category "${name}" not found.`);
    const catId = Number(cat.id);
    const catName = String(cat.name ?? `#${catId}`);

    // Count FK references. All three tables scope by user_id so cross-tenant
    // counts can never leak. PG returns BIGINT-as-string; cast to Number.
    const txCountRow = await q(db, sql`SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ${userId} AND category_id = ${catId}`) as { cnt: string | number }[];
    // FINLYNQ-84: actions are JSONB. Count rules whose actions array
    // includes a set_category action with this category id (or whose
    // create_transfer's destAccountId / set_account's accountId resolves
    // — only set_category matters here for category-delete FK check).
    const ruleCountRow = await q(db, sql`
      SELECT COUNT(*) AS cnt FROM transaction_rules
      WHERE user_id = ${userId}
        AND actions @> ${JSON.stringify([{ kind: "set_category", categoryId: catId }])}::jsonb
    `) as { cnt: string | number }[];
    const subCountRow = await q(db, sql`SELECT COUNT(*) AS cnt FROM subscriptions WHERE user_id = ${userId} AND category_id = ${catId}`) as { cnt: string | number }[];
    const txCount = Number(txCountRow[0]?.cnt ?? 0);
    const ruleCount = Number(ruleCountRow[0]?.cnt ?? 0);
    const subscriptionCount = Number(subCountRow[0]?.cnt ?? 0);
    const inUse = txCount + ruleCount + subscriptionCount > 0;

    // Sign the confirmation token even when FKs are non-zero — execute will
    // re-check and refuse atomically. This way the preview shape is stable
    // and Claude can decide whether to reassign first or pick a new target.
    const confirmationToken = signPreviewToken(userId, "delete_category", { id: catId });

    return text({
      success: true,
      data: {
        id: catId,
        name: catName,
        txCount,
        ruleCount,
        subscriptionCount,
        inUse,
        confirmationToken,
        ...(inUse
          ? { hint: "Reassign dependents before delete: use `preview_bulk_categorize` + `execute_bulk_categorize` to move transactions, `update_rule` / `delete_rule` for rules, `update_subscription` for subscriptions." }
          : {}),
      },
    });
  }

  // ── op: delete (commit) — lifted VERBATIM from delete_category ──────────────
  async function opDeleteCommit(args: { id: number; confirmation_token: string }): Promise<ToolResult> {
    const { id, confirmation_token } = args;
    const check = verifyPreviewToken(confirmation_token, userId, "delete_category", { id });
    if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run manage_categories op=delete (no token) to preview.`);

    const existing = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId} AND id = ${id}`);
    if (!existing.length) return err(`Category #${id} not found.`);
    const catRow = decryptNameish(existing, dek)[0];
    const catName = String(catRow.name ?? `#${id}`);

    // Re-check FK references atomically — token is bound to id only; a row
    // could have been categorized between preview and execute.
    const txCountRow = await q(db, sql`SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ${userId} AND category_id = ${id}`) as { cnt: string | number }[];
    // FINLYNQ-84: count via JSONB @> containment.
    const ruleCountRow = await q(db, sql`
      SELECT COUNT(*) AS cnt FROM transaction_rules
      WHERE user_id = ${userId}
        AND actions @> ${JSON.stringify([{ kind: "set_category", categoryId: id }])}::jsonb
    `) as { cnt: string | number }[];
    const subCountRow = await q(db, sql`SELECT COUNT(*) AS cnt FROM subscriptions WHERE user_id = ${userId} AND category_id = ${id}`) as { cnt: string | number }[];
    const txCount = Number(txCountRow[0]?.cnt ?? 0);
    const ruleCount = Number(ruleCountRow[0]?.cnt ?? 0);
    const subscriptionCount = Number(subCountRow[0]?.cnt ?? 0);
    if (txCount + ruleCount + subscriptionCount > 0) {
      return err(
        `Category "${catName}" still referenced by ${txCount} transaction(s), ${ruleCount} rule(s), ${subscriptionCount} subscription(s). Reassign dependents first (use bulk_categorize for transactions, update_rule/delete_rule for rules, update_subscription for subscriptions).`
      );
    }

    await db.execute(sql`DELETE FROM categories WHERE id = ${id} AND user_id = ${userId}`);
    // Load-bearing per CLAUDE.md: every MCP tx-mutating write invalidates
    // the per-user tx cache. Mirrors `delete_budget` precedent.
    invalidateUserTxCache(userId);
    return text({ success: true, data: { id, message: `Category "${catName}" deleted` } });
  }

  // ── op: create — lifted VERBATIM from create_category ──────────────────────
  async function opCreate(args: {
    name: string;
    type: "E" | "I" | "R";
    group?: string;
    note?: string;
  }): Promise<ToolResult> {
    const { name, type, group, note } = args;
    // Stream D Phase 4 — plaintext name dropped; lookup-only collision check.
    const lookup = dek ? nameLookup(dek, name) : null;
    if (!lookup) return err("Cannot create category without an unlocked DEK (Stream D Phase 4).");
    const existing = await q(db, sql`
      SELECT id FROM categories WHERE user_id = ${userId} AND name_lookup = ${lookup}
    `);
    if (existing.length) return err(`Category "${name}" already exists`);

    const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
    const result = await q(db, sql`
      INSERT INTO categories (user_id, type, "group", note, name_ct, name_lookup)
      VALUES (${userId}, ${type}, ${group ?? ""}, ${encNote(note)}, ${n.ct}, ${n.lookup})
      RETURNING id
    `);
    return text({ success: true, data: { categoryId: result[0]?.id, message: `Category "${name}" created (${type === "E" ? "expense" : type === "I" ? "income" : "transfer"})` } });
  }

  // ── shared: resolve a category id (id fast-path over fuzzy name) ────────────
  // FINLYNQ-275. Mirrors opDeletePreview's resolution but throws
  // PreviewAbortError so it can front both the direct rename write AND the
  // merge two-step (withConfirmation catches the abort → clean err, no token).
  // Returns the decrypted category Row (carries `id` + `name`).
  async function resolveCategoryStrictOrAbort(a: { id?: number; name?: string }): Promise<Row> {
    const { id, name } = a;
    if (id == null && (name == null || name === "")) {
      throw new PreviewAbortError("Pass `id` (numeric) or `name` (fuzzy) to identify the category.");
    }
    if (id != null) {
      const rows = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId} AND id = ${id}`);
      if (!rows.length) throw new PreviewAbortError(`Category #${id} not found.`);
      return decryptNameish(rows, dek)[0];
    }
    if (!dek) throw new PreviewAbortError("Cannot resolve category by name without an unlocked DEK (Stream D Phase 4). Pass `id` instead.");
    const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
    const allCats = decryptNameish(rawCats, dek);
    // FINLYNQ-267 shared envelope — id fast-path handled above; a mistyped name
    // is REFUSED and a 2+ match ABORTS with the ambiguous candidate list.
    // FINLYNQ-273: unify the refusal message with goals/holdings via the shared
    // formatter (candidates WITH ids for both ambiguous + not_found).
    const env = resolveEntity({ entity: "category", name, options: allCats });
    if (env.status !== "resolved") throw new PreviewAbortError(formatResolveFailure("category", env)!);
    const cat = allCats.find((c) => Number(c.id) === env.id);
    if (!cat) throw new PreviewAbortError(`Category "${name}" not found.`);
    return cat;
  }

  // ── shared: count every dependent of a category, per type ───────────────────
  // FINLYNQ-275. The `delete` guard counts transactions/rules/subscriptions;
  // merge must repoint EVERY table with a category_id FK. The table list and the
  // SQL live in src/lib/categories/merge.ts (shared with the Settings UI).
  async function countCategoryDependents(catId: number): Promise<CategoryDependentCounts> {
    return countCategoryDependentsShared(db, userId, catId);
  }

  // ── op: rename — pure metadata write (FINLYNQ-275) ──────────────────────────
  // Resolves the target (id fast-path over fuzzy name), refuses a unique-name
  // conflict with a CLEAR error (not a raw DB constraint 500), then re-writes
  // name_ct + name_lookup. NOT a re-cluster (categories aren't securities) — the
  // FK from every dependent stays put; only the label changes.
  async function opRename(args: { id?: number; name?: string; new_name: string }): Promise<ToolResult> {
    const newName = args.new_name?.trim();
    if (!newName) return err("`new_name` is required and cannot be empty.");
    if (!dek) return err("Cannot rename a category without an unlocked DEK (Stream D Phase 4).");
    let cat: Row;
    try {
      cat = await resolveCategoryStrictOrAbort({ id: args.id, name: args.name });
    } catch (e) {
      if (e instanceof PreviewAbortError) return err(e.message);
      throw e;
    }
    const catId = Number(cat.id);
    const oldName = String(cat.name ?? `#${catId}`);
    // Unique-name conflict check via the name_lookup HMAC (mirrors opCreate).
    const newLookup = nameLookup(dek, newName);
    const clash = await q(db, sql`
      SELECT id FROM categories WHERE user_id = ${userId} AND name_lookup = ${newLookup} AND id <> ${catId}
    `);
    if (clash.length) return err(`Category "${newName}" already exists (id=${Number(clash[0].id)}). Pick a different name or merge into it.`);
    const n = encryptName(dek, newName);
    await db.execute(sql`
      UPDATE categories SET name_ct = ${n.ct}, name_lookup = ${n.lookup}
      WHERE id = ${catId} AND user_id = ${userId}
    `);
    // A rename changes the DISPLAYED category name on decrypted tx reads
    // (getTransactions LEFT JOINs categories), so drop the per-user tx cache.
    invalidateUserTxCache(userId);
    return text({ success: true, data: { id: catId, oldName, newName, message: `Category "${oldName}" renamed to "${newName}"` } });
  }

  // ── op: merge — token-gated atomic repoint of ALL dependents (FINLYNQ-275) ──
  // TWO-STEP via the shared withConfirmation middleware: a bare call previews
  // per-type dependent counts + a token (writes NOTHING); a valid token commits
  // — one db.transaction repoints every dependent source→target, then DELETEs
  // the source. The token payload BINDS the resolved {source,target} ids.
  type MergeArgs = {
    source?: number | string;
    target?: number | string;
    confirmation_token?: string;
    // memo slots — resolved once, shared across required/preview/tokenPayload/commit.
    __src?: Row;
    __tgt?: Row;
  };
  // A `source|target` may be a numeric id (fast-path) or a fuzzy name string.
  function splitIdName(v: number | string | undefined): { id?: number; name?: string } {
    if (v == null) return {};
    if (typeof v === "number") return { id: v };
    const asNum = Number(v.trim());
    if (v.trim() !== "" && Number.isInteger(asNum) && asNum > 0 && String(asNum) === v.trim()) return { id: asNum };
    return { name: v };
  }
  async function resolveMerge(a: MergeArgs): Promise<{ src: Row; tgt: Row }> {
    if (a.__src && a.__tgt) return { src: a.__src, tgt: a.__tgt };
    const src = await resolveCategoryStrictOrAbort(splitIdName(a.source));
    const tgt = await resolveCategoryStrictOrAbort(splitIdName(a.target));
    if (Number(src.id) === Number(tgt.id)) {
      throw new PreviewAbortError("Source and target are the same category — nothing to merge.");
    }
    a.__src = src;
    a.__tgt = tgt;
    return { src, tgt };
  }

  const mergeHandler = withConfirmation<MergeArgs>(userId, {
    operation: "merge_category",
    tokenPayload: (a) => ({ source: a.__src ? Number(a.__src.id) : null, target: a.__tgt ? Number(a.__tgt.id) : null }),
    preview: async (a) => {
      const { src, tgt } = await resolveMerge(a);
      const srcId = Number(src.id);
      const deps = await countCategoryDependents(srcId);
      const total = totalCategoryDependents(deps);
      return {
        source: { id: srcId, name: String(src.name ?? `#${srcId}`) },
        target: { id: Number(tgt.id), name: String(tgt.name ?? `#${Number(tgt.id)}`) },
        dependents: deps,
        totalDependents: total,
        action: `Repoint ${total} dependent row(s) to "${String(tgt.name ?? `#${Number(tgt.id)}`)}" then delete "${String(src.name ?? `#${srcId}`)}".`,
      };
    },
    commit: async (a) => {
      const { src, tgt } = await resolveMerge(a);
      const srcId = Number(src.id);
      const tgtId = Number(tgt.id);
      // Shared core: re-counts, then one db.transaction repoints every
      // dependent source→target and deletes the source. ctx.db is the real
      // Drizzle instance at runtime (the route passes `db` from @/db).
      const before = await mergeCategoryInto(db, userId, srcId, tgtId);
      // Transactions moved category → drop the per-user tx cache.
      invalidateUserTxCache(userId);
      return text({
        success: true,
        data: {
          merged: true,
          source: srcId,
          target: tgtId,
          repointed: {
            transactions: before.transactions,
            splits: before.splits,
            subscriptions: before.subscriptions,
            budgets: before.budgets,
            budgetTemplates: before.budgetTemplates,
            recurringTransactions: before.recurringTransactions,
            emailRules: before.emailRules,
            rules: before.rules,
          },
          message: `Merged category #${srcId} into #${tgtId} and deleted the source.`,
        },
      });
    },
  });

  // ── consolidated tool ───────────────────────────────────────────────────────
  // `op: create | rename | merge | delete`. delete + merge are preview→token
  // two-steps: WITHOUT `confirmation_token` they return a summary + a token
  // (read-only preview); WITH the token they commit. rename + create write
  // directly.
  registerManageTool(
    server,
    "manage_categories",
    "Manage transaction categories: `op` selects create / rename / merge / delete. create: a new category (name + type E/I/R). rename: change a category's name (`id`/`name` + `new_name`); a duplicate name is refused. merge: TWO-STEP — call with `source`+`target` and NO `confirmation_token` to preview per-type dependent counts + get a token, then call again with the same source/target + that `confirmation_token` to atomically repoint EVERY dependent (transactions/splits/rules/subscriptions/budgets/…) into the target and delete the source. delete: TWO-STEP — preview FK counts + token, then commit; delete refuses while any dependent still references the category (use merge to fold it into another).",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("create"),
        name: z.string().describe("Category name (must be unique)"),
        type: z.enum(["E", "I", "R"]).describe("Type: 'E'=expense, 'I'=income, 'R'=transfer"),
        group: z.string().optional().describe("Group label (e.g. 'Housing', 'Food')"),
        note: z.string().optional(),
      }),
      z.object({
        op: z.literal("rename"),
        id: z.number().int().positive().optional().describe("Category FK (categories.id). Exact match — preferred; wins over `name`."),
        name: z.string().optional().describe("Category name (fuzzy matched). Requires an unlocked DEK. Pass `id` instead when no DEK is available."),
        new_name: z.string().describe("The new category name. Must be unique — a clash is refused with a clear error."),
      }),
      z.object({
        op: z.literal("merge"),
        source: z.union([z.number().int().positive(), z.string()]).optional().describe("Source category to fold into the target: a numeric id (fast-path) or a fuzzy name. Its dependents are repointed to the target, then it is deleted."),
        target: z.union([z.number().int().positive(), z.string()]).optional().describe("Target category that will own all of the source's dependents: a numeric id (fast-path) or a fuzzy name."),
        confirmation_token: z.string().optional().describe("Token from the preview call for this exact source→target pair. Omit to preview per-type dependent counts; pass verbatim to commit. Single-use; 5-minute TTL."),
      }),
      z.object({
        op: z.literal("delete"),
        id: z.number().int().positive().optional().describe("Category FK (categories.id). Exact match — preferred. Required on the COMMIT call unless `name` is passed."),
        name: z.string().optional().describe("Category name (fuzzy matched — mistyped/unmatched is REFUSED with a `Did you mean` list; 2+ → ambiguous). Accepted on BOTH preview and commit (FINLYNQ-273 — the token binds the resolved id, so a name on commit is just routing). Requires an unlocked DEK. Pass `id` instead when no DEK is available."),
        confirmation_token: z.string().optional().describe("Token from the preview call for this exact id. Omit to preview; pass verbatim to commit. Single-use; 5-minute TTL."),
      }),
    ]),
    async (input) => {
      if (input.op === "create") return opCreate(input);
      if (input.op === "rename") return opRename({ id: input.id, name: input.name, new_name: input.new_name });
      if (input.op === "merge") return mergeHandler({ source: input.source, target: input.target, confirmation_token: input.confirmation_token });
      // delete: token present → commit; absent → preview.
      if (input.confirmation_token) {
        // FINLYNQ-273 — the COMMIT accepts a resolver `name` (the token binds the
        // resolved id, so name-on-commit is pure routing). id fast-path wins;
        // else resolve the name → id via the SAME path the preview used.
        let commitId = input.id;
        if (commitId == null) {
          if (input.name == null || input.name === "") {
            return err("Pass `id` (numeric) or `name` with `confirmation_token` to commit the delete.");
          }
          let cat: Row;
          try {
            cat = await resolveCategoryStrictOrAbort({ name: input.name });
          } catch (e) {
            if (e instanceof PreviewAbortError) return err(e.message);
            throw e;
          }
          commitId = Number(cat.id);
        }
        return opDeleteCommit({ id: commitId, confirmation_token: input.confirmation_token });
      }
      return opDeletePreview({ id: input.id, name: input.name });
    },
  );

}
