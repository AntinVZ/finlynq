/**
 * /api/settings/locale — the interface language (P8 stage 6).
 *
 * GET → { language, preference: { language: "auto" | code }, source, available: LocaleMeta[] }
 * PUT { language: "auto" | code } → the same shape.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { availableLocales, isSupportedLocale } from "@/lib/i18n";
import { resolveUiLocale, setUiLocalePreference } from "@/lib/i18n/settings";

async function payload(userId: string, accept: string | null) {
  return { ...(await resolveUiLocale(db, userId, accept)), available: availableLocales() };
}

export const GET = apiHandler({ auth: "auth", raw: true, fallbackMessage: "Failed to load the language" }, async ({ request, userId }) =>
  NextResponse.json(await payload(userId, request.headers.get("accept-language"))),
);

const putSchema = z.object({
  language: z.string().max(16).refine((v) => v === "auto" || isSupportedLocale(v), { message: "Unknown language" }),
});

export const PUT = apiHandler({ auth: "auth", raw: true, body: putSchema, fallbackMessage: "Failed to save the language" }, async ({ request, userId, body }) => {
  await setUiLocalePreference(db, userId, body.language);
  return NextResponse.json(await payload(userId, request.headers.get("accept-language")));
});
