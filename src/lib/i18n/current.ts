/**
 * The language of the current request, for texts built deep in shared code
 * (server messages, reasons, warnings) — P8 stage 6.
 *
 *   st("srv.payees.nameEmpty")   → in the language of the current request
 *
 * Isomorphic: on the server ./server.ts plugs in an AsyncLocalStorage
 * (set by `apiHandler({ locale: true })` and the MCP payee tool); anywhere
 * else, or outside a request, it is English.
 */
import { translate } from "./index";
import { DEFAULT_LOCALE } from "./registry";
import type { MessageKey, TranslateVars } from "./types";

let getter: () => string | undefined = () => undefined;

/** Server only: where the current request's language comes from. */
export function setCurrentLocaleGetter(fn: () => string | undefined): void {
  getter = fn;
}

export function currentLocale(): string {
  return getter() ?? DEFAULT_LOCALE;
}

/** Translate into the current request's language. */
export function st(key: MessageKey, vars?: TranslateVars): string {
  return translate(currentLocale(), key, vars);
}
