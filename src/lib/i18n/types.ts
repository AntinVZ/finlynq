/**
 * Interface languages (P8 stage 6). A language is ONE file in ./locales
 * (`meta` + `messages`) plus one line in ./registry.ts. English is the
 * master: its keys are the type every other language must fill, and the
 * fallback for anything missing.
 */
export type LocaleMeta = {
  /** BCP 47 code, also passed to `Intl` (pseudo locales map to `en`). */
  code: string;
  /** Name in English (settings, docs). */
  name: string;
  /** Name in the language itself (the language picker). */
  nativeName: string;
  dir: "ltr" | "rtl";
  /** Development-only test locale (stretched / mirrored English). */
  pseudo?: boolean;
};

export type MessageKey = keyof typeof import("./locales/en").messages;

/** A complete message table: a language file that misses a key fails tsc. */
export type Messages = Record<MessageKey, string>;

export type TranslateVars = Record<string, string | number>;

/** A translator bound to one language (what `useT` returns). */
export type Translate = (key: MessageKey, vars?: TranslateVars) => string;
