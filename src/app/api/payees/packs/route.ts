/**
 * /api/payees/packs — country packs and the ID registry (P8 stage 7),
 * the «Словники і пакети» tab.
 *
 * GET → { packs: [PackSummary & { active }], idTypes: [{ id, label, country,
 *         person, example }], translit: [{ id, script, matching }] }
 * GET ?export=<packId> → the pack as a JSON file.
 * POST { action: "enable" | "disable", id }       built-in packs beyond UA
 * POST { action: "import", pack, dryRun? }         a JSON pack → preview / saved
 * POST { action: "remove", id }                    an imported pack
 * POST { action: "check", value }                  which ID types of the active
 *      packs the value is (with the check digit). The value is not stored.
 * Packs carry no personal data; changes apply to type words and bank
 * operations at once (the queue and suggestions are recomputed).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { getPayeeSettings, savePayeeSettings } from "@/lib/payees/settings";
import { activePacks, BUILTIN_PACKS, CUSTOM_PACKS_MAX, packIdTypes, parsePack, summarizePack } from "@/lib/payees/packs";
import { detectIdTypes, ID_TYPES } from "@/lib/payees/id-registry";
import { MATCHING_CHAIN, translitPlugins } from "@/lib/payees/translit";
import { invalidatePayeeSuggest } from "@/lib/payees/suggest";

export const GET = apiHandler({ auth: "auth", locale: true, raw: true, fallbackMessage: "Failed to load country packs" }, async ({ request, userId }) => {
  const settings = await getPayeeSettings(db, userId);
  const all = [...BUILTIN_PACKS, ...settings.customPacks];
  const exportId = request.nextUrl.searchParams.get("export");
  if (exportId) {
    const pack = all.find((p) => p.id === exportId);
    if (!pack) return NextResponse.json({ error: "No such pack" }, { status: 404 });
    return new NextResponse(JSON.stringify(pack, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="finlynq-pack-${pack.id}.json"` },
    });
  }
  const active = new Set(activePacks(settings).map((p) => p.id));
  return NextResponse.json({
    packs: all.map((p) => ({ ...summarizePack(p), active: active.has(p.id) })),
    idTypes: ID_TYPES.map((t) => ({ id: t.id, label: t.label, country: t.country, person: t.person, example: t.example })),
    translit: translitPlugins().map((p) => ({ id: p.id, script: p.script, matching: MATCHING_CHAIN.includes(p.id) })),
  });
});

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enable"), id: z.string().max(40) }),
  z.object({ action: z.literal("disable"), id: z.string().max(40) }),
  z.object({ action: z.literal("import"), pack: z.unknown(), dryRun: z.boolean().optional() }),
  z.object({ action: z.literal("remove"), id: z.string().max(40) }),
  z.object({ action: z.literal("check"), value: z.string().min(1).max(60) }),
]);

export const POST = apiHandler({ auth: "auth", locale: true, raw: true, body: postSchema, fallbackMessage: "Failed to update country packs" }, async ({ userId, body }) => {
  const settings = await getPayeeSettings(db, userId);
  const changed = () => invalidatePayeeSuggest(userId);
  switch (body.action) {
    case "check":
      return NextResponse.json({ matches: detectIdTypes(body.value, packIdTypes(activePacks(settings))) });
    case "enable":
    case "disable": {
      if (body.id === "ua" || !BUILTIN_PACKS.some((p) => p.id === body.id)) return NextResponse.json({ error: "Only built-in packs other than UA can be switched" }, { status: 400 });
      const packs = body.action === "enable" ? [...new Set([...settings.packs, body.id])] : settings.packs.filter((x) => x !== body.id);
      await savePayeeSettings(db, userId, { packs });
      changed();
      return NextResponse.json({ ok: true });
    }
    case "remove": {
      await savePayeeSettings(db, userId, { customPacks: settings.customPacks.filter((p) => p.id !== body.id) });
      changed();
      return NextResponse.json({ ok: true });
    }
    case "import": {
      const { pack, errors } = parsePack(body.pack);
      if (!pack) return NextResponse.json({ errors }, { status: 400 });
      const replaces = settings.customPacks.some((p) => p.id === pack.id);
      if (!replaces && settings.customPacks.length >= CUSTOM_PACKS_MAX) return NextResponse.json({ errors: [{ path: "", message: `At most ${CUSTOM_PACKS_MAX} imported packs` }] }, { status: 400 });
      if (body.dryRun) return NextResponse.json({ preview: summarizePack(pack), replaces });
      await savePayeeSettings(db, userId, { customPacks: [...settings.customPacks.filter((p) => p.id !== pack.id), pack] });
      changed();
      return NextResponse.json({ saved: summarizePack(pack), replaces });
    }
  }
});
