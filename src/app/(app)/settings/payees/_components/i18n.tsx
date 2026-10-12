"use client";

/**
 * Payee Studio language for client components (P6.2). Reads the Studio
 * settings (GET /api/payees/settings, cached by SWR across the Studio's
 * screens) and returns a translator bound to its `language` (default "uk").
 */

import { useCallback } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import { studioT, type StudioLang, type StudioT, type StudioTextKey } from "@/lib/payees/i18n";

export type { StudioT, StudioTextKey } from "@/lib/payees/i18n";

export function useStudioLang(): StudioLang {
  const { data } = useSWR<{ language?: StudioLang }>("/api/payees/settings", jsonFetcher, { revalidateOnFocus: false });
  return data?.language === "en" ? "en" : "uk";
}

export function useStudioT(): StudioT {
  const lang = useStudioLang();
  return useCallback((key: StudioTextKey, vars?: Record<string, string | number>) => studioT(lang, key, vars), [lang]);
}
