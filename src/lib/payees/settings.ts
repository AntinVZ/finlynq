/**
 * Payee Studio settings (one JSON value in the per-user `settings` table,
 * key `payee_studio`). Every field is optional on the wire; missing or
 * malformed values fall back to the defaults below.
 *
 *   advancedMode      show the requisites section (IBAN, tax id, …) in the UI
 *   identifierKinds   which identifier kinds the requisites section offers
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { IDENTIFIER_KINDS, type IdentifierKind } from "./directory";
import type { PayeeExecutor } from "./scan";

export const PAYEE_SETTINGS_KEY = "payee_studio";

export type PayeeStudioSettings = {
  advancedMode: boolean;
  identifierKinds: IdentifierKind[];
};

export const DEFAULT_PAYEE_SETTINGS: PayeeStudioSettings = {
  advancedMode: false,
  identifierKinds: [...IDENTIFIER_KINDS],
};

/** Merge a partial / untrusted value over the defaults. */
export function coercePayeeSettings(raw: unknown): PayeeStudioSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kinds = Array.isArray(v.identifierKinds)
    ? v.identifierKinds.filter((k): k is IdentifierKind => (IDENTIFIER_KINDS as readonly string[]).includes(String(k)))
    : DEFAULT_PAYEE_SETTINGS.identifierKinds;
  return {
    advancedMode: typeof v.advancedMode === "boolean" ? v.advancedMode : DEFAULT_PAYEE_SETTINGS.advancedMode,
    identifierKinds: [...new Set(kinds)],
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
