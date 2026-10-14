/**
 * Payee Studio interface texts (P6.2, item 83). Since P8 stage 6 they live in
 * the app-wide message files (src/lib/i18n/locales/*.ts) and the language is
 * the interface language; this module keeps the Studio's names.
 *
 * Not translated: payee names and user-renamed merchant types (user data).
 */
import { translate, type MessageKey, type Translate, type TranslateVars } from "@/lib/i18n";
import * as en from "@/lib/i18n/locales/en";
import * as uk from "@/lib/i18n/locales/uk";

/** An interface language code ("en", "uk", …). */
export type StudioLang = string;

/** The Studio's two original tables, for tests and tools. */
export const STUDIO_TEXT = { uk: uk.messages, en: en.messages } as const;

export type StudioTextKey = MessageKey;

/** A translator bound to one language (what `useStudioT` returns). */
export type StudioT = Translate;

export function studioT(lang: StudioLang, key: StudioTextKey, vars?: TranslateVars): string {
  return translate(lang, key, vars);
}
