/**
 * Server side of ./current.ts (P8 stage 6): the request's interface language
 * in an AsyncLocalStorage, so server messages follow the user's language.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { setCurrentLocaleGetter } from "./current";
import type { PayeeExecutor } from "@/lib/payees/scan";
import { resolveUiLocale } from "./settings";

const store = new AsyncLocalStorage<string>();
setCurrentLocaleGetter(() => store.getStore());

export function runWithLocale<T>(locale: string, fn: () => T): T {
  return store.run(locale, fn);
}

/** Run `fn` in the user's interface language (saved → Studio → browser → English). */
export async function runInUserLocale<T>(executor: PayeeExecutor, userId: string, acceptLanguage: string | null, fn: () => Promise<T>): Promise<T> {
  const { language } = await resolveUiLocale(executor, userId, acceptLanguage);
  return runWithLocale(language, fn);
}
