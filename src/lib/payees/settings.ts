/**
 * Payee Studio settings (one JSON value in the per-user `settings` table,
 * key `payee_studio`). Every field is optional on the wire; missing or
 * malformed values fall back to the defaults below.
 *
 *   advancedMode        show the requisites section (IBAN, tax id, …) in the UI
 *   identifierKinds     which identifier kinds the requisites section offers
 *   importHint          (P3, default OFF) new staged rows and new manual
 *                       transactions whose payee matches an alias get the
 *                       canonical name
 *   autopilotEnabled    (P3, default OFF) on import, a NEW payee that matches
 *                       exactly one directory entry at or above the threshold
 *                       is renamed and its spelling added as an alias —
 *                       journaled as an undoable batch; never for people
 *   autopilotThreshold  0.75–0.99, default 0.9
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { IDENTIFIER_KINDS, type IdentifierKind } from "./directory";
import type { PayeeExecutor } from "./scan";

export const PAYEE_SETTINGS_KEY = "payee_studio";

export type PayeeStudioSettings = {
  advancedMode: boolean;
  identifierKinds: IdentifierKind[];
  importHint: boolean;
  autopilotEnabled: boolean;
  autopilotThreshold: number;
};

export const AUTOPILOT_MIN_THRESHOLD = 0.75;
export const AUTOPILOT_MAX_THRESHOLD = 0.99;

export const DEFAULT_PAYEE_SETTINGS: PayeeStudioSettings = {
  advancedMode: false,
  identifierKinds: [...IDENTIFIER_KINDS],
  importHint: false,
  autopilotEnabled: false,
  autopilotThreshold: 0.9,
};

/** Merge a partial / untrusted value over the defaults. */
export function coercePayeeSettings(raw: unknown): PayeeStudioSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kinds = Array.isArray(v.identifierKinds)
    ? v.identifierKinds.filter((k): k is IdentifierKind => (IDENTIFIER_KINDS as readonly string[]).includes(String(k)))
    : DEFAULT_PAYEE_SETTINGS.identifierKinds;
  const threshold = typeof v.autopilotThreshold === "number" && Number.isFinite(v.autopilotThreshold) ? v.autopilotThreshold : DEFAULT_PAYEE_SETTINGS.autopilotThreshold;
  return {
    advancedMode: typeof v.advancedMode === "boolean" ? v.advancedMode : DEFAULT_PAYEE_SETTINGS.advancedMode,
    identifierKinds: [...new Set(kinds)],
    importHint: typeof v.importHint === "boolean" ? v.importHint : DEFAULT_PAYEE_SETTINGS.importHint,
    autopilotEnabled: typeof v.autopilotEnabled === "boolean" ? v.autopilotEnabled : DEFAULT_PAYEE_SETTINGS.autopilotEnabled,
    autopilotThreshold: Math.round(Math.min(AUTOPILOT_MAX_THRESHOLD, Math.max(AUTOPILOT_MIN_THRESHOLD, threshold)) * 100) / 100,
  };
}

export async function getPayeeSettings(executor: PayeeExecutor, userId: string): Promise<PayeeStudioSettings> {
  const rows = normalizeDbRows<{ value: unknown }>(
    await executor.execute(sql`SELECT value FROM settings WHERE key = ${PAYEE_SETTINGS_KEY} AND user_id = ${userId}`),
  );
  if (!rows.length) return { ...DEFAULT_PAYEE_SETTINGS };
  try {
    return coercePayeeSettings(JSON.parse(String(rows[0].value)));
  } catch {
    return { ...DEFAULT_PAYEE_SETTINGS };
  }
}

export async function savePayeeSettings(
  executor: PayeeExecutor,
  userId: string,
  patch: Partial<PayeeStudioSettings>,
): Promise<PayeeStudioSettings> {
  const next = coercePayeeSettings({ ...(await getPayeeSettings(executor, userId)), ...patch });
  await executor.execute(sql`
    INSERT INTO settings (key, user_id, value) VALUES (${PAYEE_SETTINGS_KEY}, ${userId}, ${JSON.stringify(next)})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value`);
  return next;
}
