/**
 * Interface translations (P8 stage 6). Pure, used on the web and the server:
 *
 *   translate("uk", "common.rows", { n: 3 })  → "3 рядки"
 *   translatorFor("en")                        → a bound `Translate`
 *
 * Client components use `useT()` from ./client. A key missing in a language
 * falls back to English; a key missing everywhere is returned as is (and
 * caught by tests/i18n-locales.test.ts).
 */
import { formatMessage } from "./format-message";
import { DEFAULT_LOCALE, intlLocaleOf, localeEntry } from "./registry";
import * as en from "./locales/en";
import type { MessageKey, Translate, TranslateVars } from "./types";

export type { LocaleMeta, MessageKey, Messages, Translate, TranslateVars } from "./types";
export { availableLocales, DEFAULT_LOCALE, intlLocaleOf, isSupportedLocale, negotiateLocale } from "./registry";

export function translate(locale: string, key: MessageKey, vars?: TranslateVars): string {
  const table = localeEntry(locale || DEFAULT_LOCALE).messages as Record<string, string>;
  const template = table[key] ?? (en.messages as Record<string, string>)[key] ?? key;
  return formatMessage(template, intlLocaleOf(locale || DEFAULT_LOCALE), vars);
}

export function translatorFor(locale: string): Translate {
  return (key, vars) => translate(locale, key, vars);
}
