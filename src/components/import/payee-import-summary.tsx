"use client";

/**
 * «Платники в цьому імпорті» (P8 stage 10): the post-import summary for a
 * staged import, file or email — how many rows were recognized by a
 * requisite, by an exact alias, by another alias, how many only got a
 * merchant-type hint, and how many wait in Merchants → Queue; channels,
 * own transfers and bank operations apart. An email import is staged
 * without the key, so «Застосувати підказки» runs the import hint /
 * autopilot now (as set in Merchants → Settings; undoable in Changes).
 */

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import type { ImportPayeeSummary } from "@/lib/payees/import-assist";

export function PayeeImportSummaryView({ summary }: { summary: ImportPayeeSummary }) {
  const t = useT();
  const parts: Array<[string, number]> = [
    [t("importSummary.byRequisite", { n: summary.byRequisite }), summary.byRequisite],
    [t("importSummary.byAlias", { n: summary.byAlias }), summary.byAlias],
    [t("importSummary.byPattern", { n: summary.byPattern }), summary.byPattern],
    [t("importSummary.channels", { n: summary.channels }), summary.channels],
    [t("importSummary.own", { n: summary.own }), summary.own],
    [t("importSummary.bankOps", { n: summary.bankOps }), summary.bankOps],
    [t("importSummary.ambiguous", { n: summary.ambiguous }), summary.ambiguous],
  ];
  return (
    <div className="space-y-1 text-sm" data-testid="payee-import-summary">
      <p>
        {parts.filter(([, n]) => n > 0).map(([s]) => s).join(" · ") || t("importSummary.noneRecognized")}
      </p>
      {summary.toQueue > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("importSummary.toQueue", { n: summary.toQueue, s: summary.newSpellings })}
          {summary.byType > 0 ? ` ${t("importSummary.byType", { n: summary.byType })}` : ""}{" "}
          <Link href="/merchants?tab=queue&view=unrecognized" className="underline">{t("importSummary.openQueue")}</Link>
        </p>
      )}
      {(summary.hinted > 0 || summary.autopilot > 0) && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">
          {t("importSummary.renamed", { n: summary.hinted + summary.autopilot })}
          {summary.aliasesAdded > 0 ? ` ${t("importSummary.aliasesAdded", { n: summary.aliasesAdded })}` : ""}
        </p>
      )}
    </div>
  );
}

/** The card on a staged import's review page. */
export function PayeeImportSummaryCard({ stagedImportId, pending }: { stagedImportId: string; pending: boolean }) {
  const t = useT();
  const url = `/api/import/staged/${encodeURIComponent(stagedImportId)}/payee-summary`;
  const { data, mutate } = useSWR<{ summary: ImportPayeeSummary }>(url, jsonFetcher, { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!data?.summary || data.summary.rows === 0) return null;
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(url, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) setError(d?.error ?? t("importSummary.failed"));
      else await mutate({ summary: d.summary }, { revalidate: false });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-sm">{t("importSummary.title")}</p>
        {pending && (
          <Button size="sm" variant="outline" className="ms-auto h-7 text-xs" onClick={apply} disabled={busy}>
            {busy ? t("common.working") : t("importSummary.apply")}
          </Button>
        )}
      </div>
      <PayeeImportSummaryView summary={data.summary} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
