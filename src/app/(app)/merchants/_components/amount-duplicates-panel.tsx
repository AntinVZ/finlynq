"use client";

/**
 * Duplicates by amount (P8 stage 11): two different payees paid the same
 * amount on the same day at least twice. Each pair shows its evidence;
 * «Об'єднати…» opens the usual merge preview, «Різні» hides the pair for
 * good (undo right away from the status line). Nothing is merged here.
 */

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { ActionButton } from "@/components/actions/action-button";
import { formatCurrency, formatDate } from "@/lib/i18n/format-current";
import { useT } from "@/lib/i18n/client";
import { needsDecisionBadge } from "./payee-ui";

export type AmountSide = { ref: string; name: string; entityId: number | null; key: string | null; person: boolean; count: number };
export type AmountPair = { id: string; a: AmountSide; b: AmountSide; matches: Array<{ date: string; amount: number; currency: string | null }>; shared: number; needsDecision: boolean };

function SideName({ s }: { s: AmountSide }) {
  return s.entityId != null ? (
    <Link href={`/merchants/${s.entityId}`} className="font-medium hover:underline break-all">
      {s.name}
    </Link>
  ) : (
    <span className="font-medium break-all">{s.name}</span>
  );
}

export function AmountDuplicatesPanel({ onMerge }: { onMerge: (pair: AmountPair) => void }) {
  const t = useT();
  const { data, error, mutate } = useSWR<{ pairs: AmountPair[]; total: number; truncated: boolean }>("/api/payees/amount-duplicates", jsonFetcher, { revalidateOnFocus: false });
  const [status, setStatus] = useState<{ text: string; undoId?: string } | null>(null);
  const pairs = Array.isArray(data?.pairs) ? data!.pairs : [];

  async function answer(id: string, undo = false) {
    const res = await fetch("/api/payees/amount-duplicates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, undo }) }).catch(() => null);
    if (!res?.ok) {
      setStatus({ text: t("amountDup.failed") });
      return;
    }
    setStatus(undo ? { text: t("amountDup.restored") } : { text: t("amountDup.hidden"), undoId: id });
    await mutate();
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("amountDup.intro")}</p>
      {status && (
        <p className="text-sm" role="status">
          {status.text}{" "}
          {status.undoId && (
            <button type="button" className="underline" onClick={() => void answer(status.undoId!, true)}>
              {t("amountDup.undo")}
            </button>
          )}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{t("amountDup.loadFailed")}</p>}
      {!data && !error ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : pairs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("amountDup.empty")}</p>
      ) : (
        <ul className="space-y-2" data-testid="amount-pairs">
          {pairs.map((p) => (
            <li key={p.id} className="rounded-lg border p-3 text-sm space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <SideName s={p.a} />
                <span className="text-muted-foreground">↔</span>
                <SideName s={p.b} />
                {p.needsDecision && needsDecisionBadge(t("amountDup.person"), t)}
                <span className="text-xs text-muted-foreground">{t("amountDup.shared", { n: p.shared })}</span>
                <span className="ms-auto flex gap-1">
                  <ActionButton intent="open" className="h-7 text-xs" onClick={() => onMerge(p)}>
                    {t("amountDup.merge")}
                  </ActionButton>
                  <ActionButton intent="reject" soft className="h-7 text-xs" onClick={() => void answer(p.id)}>
                    {t("amountDup.different")}
                  </ActionButton>
                </span>
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {p.matches.map((m) => `${formatDate(m.date)} · ${m.currency ? formatCurrency(m.amount, m.currency) : m.amount}`).join("; ")}
              </p>
            </li>
          ))}
        </ul>
      )}
      {data?.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t("profile.kpi.truncated")}</p>}
    </div>
  );
}
