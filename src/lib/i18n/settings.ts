/**
 * The user's interface language (P8 stage 6): one JSON value in the
 * per-user `settings` table, key `ui_locale` — `{ "language": "auto" | code }`.
 * Kept apart from the language of the DATA (payee words, type words) and
 * from the country (stage 7 country packs).
 *
 * Resolution: the saved language → the Payee Studio language saved before
 * this setting existed (P6.2 `payee_studio.language`) → the browser
 * (Accept-Language) → English. Reads never throw.
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import type { PayeeExecutor } from "@/lib/payees/scan";
import { PAYEE_SETTINGS_KEY } from "@/lib/payees/settings";
import { isSupportedLocale, negotiateLocale } from "./registry";

export const UI_LOCALE_KEY = "ui_locale";

export type UiLocalePreference = { language: "auto" | string };

async function readSetting(executor: PayeeExecutor, userId: string, key: string): Promise<string | null> {
  try {
    const rows = normalizeDbRows<{ value: unknown }>(await executor.execute(sql`SELECT value FROM settings WHERE key = ${key} AND user_id = ${userId}`));
    return rows.length ? String(rows[0].value) : null;
  } catch {
    return null;
  }
}

function parseJson(v: string | null): Record<string, unknown> | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function getUiLocalePreference(executor: PayeeExecutor, userId: string): Promise<UiLocalePreference> {
  const v = parseJson(await readSetting(executor, userId, UI_LOCALE_KEY));
  return { language: isSupportedLocale(v?.language) ? (v!.language as string) : "auto" };
}

/** The language to show: saved → legacy Studio language → browser → English. */
export async function resolveUiLocale(executor: PayeeExecutor, userId: string, acceptLanguage: string | null): Promise<{ language: string; preference: UiLocalePreference; source: "saved" | "studio" | "browser" }> {
  const preference = await getUiLocalePreference(executor, userId);
  if (preference.language !== "auto") return { language: preference.language, preference, source: "saved" };
  const legacy = parseJson(await readSetting(executor, userId, PAYEE_SETTINGS_KEY))?.language;
  if (isSupportedLocale(legacy)) return { language: legacy, preference, source: "studio" };
  return { language: negotiateLocale(acceptLanguage), preference, source: "browser" };
}

export async function setUiLocalePreference(executor: PayeeExecutor, userId: string, language: string): Promise<UiLocalePreference> {
  const pref: UiLocalePreference = { language: isSupportedLocale(language) ? language : "auto" };
  await executor.execute(sql`
    INSERT INTO settings (key, user_id, value) VALUES (${UI_LOCALE_KEY}, ${userId}, ${JSON.stringify(pref)})
    ON CONFLICT (key, user_id) DO UPDATE SET value = EXCLUDED.value`);
  return pref;
}
