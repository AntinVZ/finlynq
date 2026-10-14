"use client";

/**
 * Transactions → merchant and merchant-type filters (P8 stage 2). The lists
 * come from the Merchants directory (`/api/payees/options`, loaded on first
 * open); the server resolves each payee through the directory after
 * decryption. With a filter on, a chip shows «56 · 38 тис ₴» — how many
 * transactions and their sum (per currency).
 */

import useSWR from "swr";
import { useState } from "react";
import { X } from "lucide-react";
import { jsonFetcher } from "@/lib/swr";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { formatCurrency } from "@/lib/i18n/format-current";
import { useT } from "@/lib/i18n/client";
import { merchantTypeLabel } from "@/app/(app)/merchants/_components/merchant-type-ui";
import type { MerchantOptions } from "@/components/rules/rule-editor-dialog";
import type { MerchantSummary } from "../_hooks/use-transactions";

export function merchantSummaryText(s: MerchantSummary): string {
  const sums = Object.entries(s.totals)
    .filter(([, v]) => v !== 0)
    .map(([cur, v]) => (cur ? formatCurrency(v, cur, { compact: Math.abs(v) >= 10_000 }) : String(v)));
  return [`${s.count}${s.truncated ? "+" : ""}`, ...sums].join(" · ");
}

export function MerchantFilters({
  merchant,
  merchantType,
  summary,
  onChange,
}: {
  merchant: string;
  merchantType: string;
  summary?: MerchantSummary;
  onChange: (patch: { merchant?: string; merchantType?: string }) => void;
}) {
  const t = useT();
  // Load the lists once the person shows interest (or a filter came in the URL).
  const [wanted, setWanted] = useState(false);
  const { data } = useSWR<MerchantOptions>(wanted || merchant || merchantType ? "/api/payees/options" : null, jsonFetcher, { revalidateOnFocus: false });
  const merchants = Array.isArray(data?.merchants) ? data!.merchants : [];
  const types = Array.isArray(data?.types) ? data!.types : [];
  const active = merchant || merchantType;
  const label = merchant ? merchants.find((m) => String(m.id) === merchant)?.name : merchantType ? (() => {
    const ty = types.find((x) => String(x.id) === merchantType);
    return ty ? merchantTypeLabel(ty, t) : undefined;
  })() : undefined;

  return (
    <>
      <div onPointerDown={() => setWanted(true)} onFocus={() => setWanted(true)}>
        <Combobox
          value={merchant}
          onValueChange={(v) => onChange({ merchant: v === "all" ? "" : (v ?? "") })}
          items={[{ value: "all", label: t("txFilter.allMerchants") } satisfies ComboboxItemShape, ...merchants.map((m): ComboboxItemShape => ({ value: String(m.id), label: m.name }))]}
          placeholder={t("txFilter.allMerchants")}
          searchPlaceholder={t("rules.search")}
          emptyMessage={t("rules.noMerchants")}
          size="sm"
          className="h-8 w-44 text-xs"
        />
      </div>
      <div onPointerDown={() => setWanted(true)} onFocus={() => setWanted(true)}>
        <Combobox
          value={merchantType}
          onValueChange={(v) => onChange({ merchantType: v === "all" ? "" : (v ?? "") })}
          items={[{ value: "all", label: t("txFilter.allTypes") } satisfies ComboboxItemShape, ...types.map((ty): ComboboxItemShape => ({ value: String(ty.id), label: merchantTypeLabel(ty, t) }))]}
          placeholder={t("txFilter.allTypes")}
          searchPlaceholder={t("rules.search")}
          emptyMessage={t("rules.noTypes")}
          size="sm"
          className="h-8 w-44 text-xs"
        />
      </div>
      {active && summary && (
        <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs" data-testid="merchant-chip" title={t("txFilter.chipTitle")}>
          {label ? <span className="font-medium">{label}:</span> : null}
          <span className="tabular-nums">{merchantSummaryText(summary)}</span>
          <button type="button" aria-label={t("txFilter.clear")} onClick={() => onChange({ merchant: "", merchantType: "" })} className="rounded hover:bg-muted">
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </>
  );
}
