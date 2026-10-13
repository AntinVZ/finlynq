"use client";

/**
 * Payee Studio texts on the client. Since P8 stage 6 the Studio follows the
 * interface language (Settings → Display → Language; `useT` from
 * @/lib/i18n/client); these names stay for the Studio's components.
 */

import { useLocale, useT } from "@/lib/i18n/client";
import type { StudioLang, StudioT } from "@/lib/payees/i18n";

export type { StudioT, StudioTextKey } from "@/lib/payees/i18n";

export function useStudioLang(): StudioLang {
  return useLocale().locale;
}

export function useStudioT(): StudioT {
  return useT();
}
