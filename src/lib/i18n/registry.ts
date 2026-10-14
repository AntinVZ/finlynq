/**
 * The interface languages (P8 stage 6). Adding a language = one file in
 * ./locales plus one line here. The two pseudo locales are generated from
 * English and offered only outside production (or with
 * NEXT_PUBLIC_I18N_PSEUDO=1) to check long strings and right-to-left layout.
 */
import * as en from "./locales/en";
import * as uk from "./locales/uk";
import { pseudoLong, pseudoRtl } from "./pseudo";
import type { LocaleMeta, Messages } from "./types";

type LocaleEntry = { meta: LocaleMeta; messages: Messages };

const REAL: LocaleEntry[] = [en, uk];

export const DEFAULT_LOCALE = "en";

const pseudoEnabled = () =>
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_I18N_PSEUDO === "1";

let pseudo: LocaleEntry[] | null = null;
function pseudoLocales(): LocaleEntry[] {
  if (!pseudo) {
    pseudo = [
      { meta: { code: "en-XA", name: "Pseudo (long)", nativeName: "[Ƥšéûðö ļöñĝ]", dir: "ltr", pseudo: true }, messages: pseudoLong(en.messages) },
      { meta: { code: "ar-XB", name: "Pseudo (RTL)", nativeName: "Pseudo RTL", dir: "rtl", pseudo: true }, messages: pseudoRtl(en.messages) },
    ];
  }
  return pseudo;
}

/** Every language the picker offers. */
export function availableLocales(): LocaleMeta[] {
  return [...REAL, ...(pseudoEnabled() ? pseudoLocales() : [])].map((l) => l.meta);
}

export function isSupportedLocale(code: unknown): code is string {
  return typeof code === "string" && availableLocales().some((l) => l.code === code);
}

export function localeEntry(code: string): LocaleEntry {
  return REAL.find((l) => l.meta.code === code) ?? (pseudoEnabled() ? pseudoLocales().find((l) => l.meta.code === code) : undefined) ?? en;
}

/** The locale `Intl` should use (pseudo locales format like English). */
export function intlLocaleOf(code: string): string {
  return localeEntry(code).meta.pseudo ? "en" : localeEntry(code).meta.code;
}

/**
 * The best supported language for an Accept-Language header or a
 * navigator.languages list (`uk-UA,uk;q=0.9,en;q=0.8` → uk), else English.
 * Pseudo locales are never picked automatically.
 */
export function negotiateLocale(accept: string | readonly string[] | null | undefined): string {
  const wanted = (typeof accept === "string" ? accept.split(",") : [...(accept ?? [])])
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find(Boolean);
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q) : 1, i };
    })
    .filter((w) => w.tag && w.tag !== "*" && w.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const w of wanted) {
    const exact = REAL.find((l) => l.meta.code.toLowerCase() === w.tag);
    if (exact) return exact.meta.code;
    const base = REAL.find((l) => l.meta.code.toLowerCase() === w.tag.split("-")[0]);
    if (base) return base.meta.code;
  }
  return DEFAULT_LOCALE;
}
