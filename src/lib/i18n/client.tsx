"use client";

/**
 * Interface language on the client (P8 stage 6).
 *
 *   const t = useT();          t("nav.merchants")
 *   const f = useFormat();     f.money(38400, "UAH", { compact: true })
 *   const { locale, setLanguage } = useLocale();
 *
 * The language comes from GET /api/settings/locale (shared SWR cache, so
 * every component reads one request). Until it arrives the interface is in
 * English. <LocaleDocumentSync/> (in the app layout) keeps <html lang dir>
 * in step.
 */

import { useCallback, useEffect, useMemo } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import { DEFAULT_LOCALE, translate } from "./index";
import { setCurrentLocaleGetter } from "./current";
import { formatDate, formatMoney, formatNumber } from "./format";
import type { LocaleMeta, Translate } from "./types";

export const LOCALE_API = "/api/settings/locale";

type LocaleResponse = {
  language: string;
  preference: { language: string };
  source?: string;
  available?: LocaleMeta[];
};

export function useLocale() {
  const { data, mutate, isLoading } = useSWR<LocaleResponse>(LOCALE_API, jsonFetcher, { revalidateOnFocus: false });
  const locale = typeof data?.language === "string" && data.language ? data.language : DEFAULT_LOCALE;
  const available = data?.available ?? [];
  const dir = available.find((l) => l.code === locale)?.dir ?? "ltr";
  const setLanguage = useCallback(
    async (language: string) => {
      const res = await fetch(LOCALE_API, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await mutate((await res.json()) as LocaleResponse, { revalidate: false });
    },
    [mutate],
  );
  return { locale, dir, available, preference: data?.preference?.language ?? "auto", isLoading, setLanguage };
}

export function useT(): Translate {
  const { locale } = useLocale();
  return useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale]);
}

export function useFormat() {
  const { locale } = useLocale();
  return useMemo(
    () => ({
      locale,
      number: (n: number, opts?: Intl.NumberFormatOptions) => formatNumber(locale, n, opts),
      money: (n: number, currency: string, opts?: { compact?: boolean }) => formatMoney(locale, n, currency, opts),
      date: (v: string | Date | null | undefined, style?: "short" | "medium" | "month") => formatDate(locale, v, style),
    }),
    [locale],
  );
}

let clientLocale: string | undefined;
function adoptCurrentLocale(locale: string) {
  if (clientLocale === locale) return;
  clientLocale = locale;
  setCurrentLocaleGetter(() => clientLocale);
}

/**
 * Sets <html lang> and <html dir> to the interface language and makes it the
 * "current" language for plain helpers (@/lib/i18n/format-current) in the
 * browser. Renders nothing.
 */
export function LocaleDocumentSync() {
  const { locale, dir, isLoading } = useLocale();
  if (typeof window !== "undefined" && !isLoading) adoptCurrentLocale(locale);
  useEffect(() => {
    if (isLoading) return;
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir, isLoading]);
  return null;
}
