"use client";

/**
 * «Рекомендовано: X» for lists of imported rows (P8 stage 4): one request
 * for all the payees on screen (POST /api/payees/resolve), a chip next to a
 * payee whose spelling resolves to a directory entry under another name.
 * Nothing changes until the chip is clicked.
 */

import useSWR from "swr";
import { Sparkles } from "lucide-react";
import { useT } from "@/lib/i18n/client";

export type Recommendation = { kind: "match"; entityId: number; name: string; via: string; same: boolean } | { kind: "ambiguous"; names: string[] };

const post = async ([url, payees]: [string, string[]]): Promise<Record<string, Recommendation>> => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payees }) }).catch(() => null);
  if (!res?.ok) return {};
  const data = (await res.json().catch(() => null)) as { results?: Record<string, Recommendation> } | null;
  return data?.results ?? {};
};

export function usePayeeRecommendations(payees: ReadonlyArray<string | null | undefined>) {
  const list = [...new Set(payees.map((p) => (p ?? "").trim()).filter(Boolean))].sort().slice(0, 500);
  const { data } = useSWR(list.length ? ["/api/payees/resolve", list] : null, post, { revalidateOnFocus: false });
  return (payee: string | null | undefined): Recommendation | null => {
    const r = data?.[(payee ?? "").trim()];
    return r && r.kind === "match" && !r.same ? r : null;
  };
}

export function RecommendedChip({ rec, onApply, busy }: { rec: Recommendation | null; onApply: (name: string) => void; busy?: boolean }) {
  const t = useT();
  if (!rec || rec.kind !== "match") return null;
  return (
    <button
      type="button"
      disabled={busy}
      className="ms-1 inline-flex max-w-full items-center gap-1 rounded-full border border-action-open-text/40 px-1.5 py-0 text-[10px] text-action-open-text hover:bg-action-open/10 disabled:opacity-50"
      title={t("payeePicker.recommendedTitle", { via: rec.via })}
      onClick={(e) => {
        e.stopPropagation();
        onApply(rec.name);
      }}
    >
      <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{t("payeePicker.recommended", { name: rec.name })}</span>
    </button>
  );
}
