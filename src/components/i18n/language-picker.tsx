"use client";

/**
 * The interface language picker (P8 stage 6): "Automatic (browser)" plus
 * every language in src/lib/i18n/registry.ts, each in its own name. Saves at
 * once; the whole interface re-renders in the new language.
 */

import { useState } from "react";
import { useLocale, useT } from "@/lib/i18n/client";

export function LanguagePicker({ className }: { className?: string }) {
  const t = useT();
  const { preference, available, setLanguage, isLoading } = useLocale();
  const [error, setError] = useState<string | null>(null);
  return (
    <label className={className ?? "flex flex-wrap items-center gap-2 text-sm"}>
      <span>{t("lang.label")}</span>
      <select
        aria-label={t("lang.label")}
        className="h-11 min-w-40 rounded-md border bg-background px-2 text-sm sm:h-8"
        value={preference}
        disabled={isLoading}
        onChange={(e) => {
          setError(null);
          setLanguage(e.target.value).catch(() => setError(t("lang.saveFailed")));
        }}
      >
        <option value="auto">{t("lang.auto")}</option>
        {available.map((l) => (
          <option key={l.code} value={l.code} lang={l.pseudo ? undefined : l.code}>
            {l.nativeName}
          </option>
        ))}
      </select>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </label>
  );
}
