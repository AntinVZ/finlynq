/**
 * /api/payees/settings — Payee Studio settings.
 *
 * GET → PayeeStudioSettings. PUT { advancedMode?, identifierKinds?,
 * importHint?, autopilotEnabled?, autopilotThreshold? } → the saved settings.
 * Every field optional; unknown values fall back to defaults (import hint and
 * autopilot are OFF unless switched on here).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { AUTOPILOT_MAX_THRESHOLD, AUTOPILOT_MIN_THRESHOLD, getPayeeSettings, savePayeeSettings } from "@/lib/payees/settings";
import { IDENTIFIER_KINDS } from "@/lib/payees/directory";

export const GET = apiHandler({ auth: "auth", raw: true, fallbackMessage: "Failed to load settings" }, async ({ userId }) =>
  NextResponse.json(await getPayeeSettings(db, userId)),
);

const putSchema = z.object({
  advancedMode: z.boolean().optional(),
  identifierKinds: z.array(z.enum(IDENTIFIER_KINDS)).max(IDENTIFIER_KINDS.length).optional(),
  importHint: z.boolean().optional(),
  autopilotEnabled: z.boolean().optional(),
  autopilotThreshold: z.number().min(AUTOPILOT_MIN_THRESHOLD).max(AUTOPILOT_MAX_THRESHOLD).optional(),
});

export const PUT = apiHandler({ auth: "auth", raw: true, body: putSchema, fallbackMessage: "Failed to save settings" }, async ({ userId, body }) =>
  NextResponse.json(await savePayeeSettings(db, userId, body)),
);
