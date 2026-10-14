/**
 * /api/payees/dictionary — export / import the payee dictionary file.
 *
 * GET ?format=json|yaml (default json) → the file as a download. Only
 *   shareable data: entries, aliases, types and public legal-entity ids —
 *   never amounts, dates, notes, private persons or sole proprietors.
 *   `X-Payee-Dictionary-Skipped` reports what was left out
 *   (people / aliases / identifiers).
 *
 * POST { content, resolutions?: { "<entryIndex>": "skip" | "create" |
 *   "merge:<entityId>" }, dryRun? }
 *   → { plan: [{ index, name, action: create|merge|unchanged|skip|conflict,
 *       target, candidates, newAliases, newIdentifiers, note }], errors,
 *       counts, batchId? }
 *   A dry run only plans. A commit is refused (409) while any entry is a
 *   conflict without a decision; otherwise it runs as ONE undoable batch and
 *   does not rename stored payees.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { loadDirectory } from "@/lib/payees/directory";
import { buildDictionary, dictionaryImportOps, dictionaryToJson, dictionaryToYaml, parseDictionary, planDictionaryImport, type Resolution } from "@/lib/payees/dictionary";
import { loadMerchantTypes } from "@/lib/payees/merchant-types";
import { dictionaryMetaOf, getPayeeSettings } from "@/lib/payees/settings";
import { executePayeeOp } from "@/lib/payees/ops";
import { payeeErrorResponse } from "@/lib/payees/route-errors";

export const GET = apiHandler({ auth: "encryption", locale: true, raw: true, fallbackMessage: "Export failed" }, async ({ request, userId, dek }) => {
  const yaml = request.nextUrl.searchParams.get("format") === "yaml";
  const dict = buildDictionary(await loadDirectory(db, userId, dek), new Date(), await loadMerchantTypes(db, userId), dictionaryMetaOf(await getPayeeSettings(db, userId)));
  const date = dict.exportedAt.slice(0, 10);
  return new NextResponse(yaml ? dictionaryToYaml(dict) : dictionaryToJson(dict), {
    headers: {
      "Content-Type": yaml ? "application/yaml; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="finlynq-payees-${date}.${yaml ? "yaml" : "json"}"`,
      "X-Payee-Dictionary-Skipped": JSON.stringify(dict.skipped),
      "Cache-Control": "no-store",
    },
  });
});

const resolution = z.union([z.literal("skip"), z.literal("create"), z.string().regex(/^merge:\d+$/)]);
const postSchema = z.object({
  content: z.string().min(1).max(5_000_000),
  resolutions: z.record(z.string().regex(/^\d+$/), resolution).optional(),
  dryRun: z.boolean().optional(),
});

export const POST = apiHandler(
  { auth: "encryption", locale: true, raw: true, body: postSchema, mapError: payeeErrorResponse, fallbackMessage: "Import failed" },
  async ({ userId, dek, body }) => {
    let parsed: ReturnType<typeof parseDictionary>;
    try {
      parsed = parseDictionary(body.content);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't read the file." }, { status: 400 });
    }
    const resolutions = Object.fromEntries(Object.entries(body.resolutions ?? {}).map(([k, v]) => [Number(k), v as Resolution]));
    const plan = planDictionaryImport(parsed.entries, await loadDirectory(db, userId, dek), resolutions);
    const counts = { create: 0, merge: 0, unchanged: 0, skip: 0, conflict: 0 };
    for (const p of plan) counts[p.action]++;
    if (body.dryRun) return NextResponse.json({ plan, errors: parsed.errors, counts });
    if (counts.conflict) return NextResponse.json({ plan, errors: parsed.errors, counts, error: "Decide what to do with every conflicting entry first." }, { status: 409 });
    const { ops, labels } = dictionaryImportOps(plan);
    if (!ops.length) return NextResponse.json({ plan, errors: parsed.errors, counts, batchId: null });
    const result = await executePayeeOp({ executor: db, userId, dek: dek!, actor: "web", op: { op: "bulk", kind: "dictionary_import", ops, labels } });
    return NextResponse.json({ plan, errors: parsed.errors, counts, batchId: result.batchId });
  },
);
