"use client";

/**
 * Merchant analyses (P5d) under Insights — GET /api/payees/insights?view=merchants.
 * Optional period and one counterparty (name or directory entry). Eight
 * sections: receipt (with a histogram), receipt trend, count vs receipt change
 * between two periods, new / quiet / returned / churned, regular payments,
 * several categories (rule hint), business and personal, people (paid vs
 * received by purpose). Amounts in the display currency.
 */

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { formatCurrency } from "@/lib/currency";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { useStudioT } from "./i18n";

type Ref = { id: string; name: string; entityId: number | null };
type Analytics = {
  currency: string;
  scanned: number;
  truncated: boolean;
  counterparties: number;
  receipt: Array<Ref & { payments: number; average: number; median: number; max: number; quartiles: [number, number, number]; histogram: Array<{ from: number; to: number; count: number }> }>;
  receiptTrend: Array<Ref & { months: Array<{ month: string; average: number; payments: number }>; trendPct: number | null }>;
  change: {
    period1: { from: string; to: string };
    period2: { from: string; to: string };
    rows: Array<Ref & { n1: number; n2: number; avg1: number; avg2: number; spend1: number; spend2: number; countEffect: number; receiptEffect: number; total: number }>;
    totals: { spend1: number; spend2: number; countEffect: number; receiptEffect: number; total: number };
  };
  lifecycle: {
    new: Array<Ref & { firstDate: string }>;
    quiet: Array<Ref & { lastDate: string; activeMonths: number }>;
    returned: Array<Ref & { lastDate: string; silentMonths: number }>;
    churned: Array<Ref & { lastDate: string }>;
  };
  regular: Array<Ref & { payments: number; intervalDays: number; cv: number; average: number; yearlyCost: number; nextExpected: string }>;
  multiCategory: Array<Ref & { categories: Array<{ name: string; rows: number; share: number }>; hint: string }>;
  businessPersonal: Array<Ref & { business: number; personal: number; businessShare: number }>;
  people: Array<Ref & { paid: number; received: number; net: number; byPurpose: Array<{ purpose: string; paid: number; received: number; rows: number }> }>;
};

const who = (r: Ref) =>
  r.entityId != null ? (
    <Link href={`/settings/payees/${r.entityId}`} className="hover:underline break-all">{r.name}</Link>
  ) : (
    <span className="break-all">{r.name}</span>
  );

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function MerchantAnalyticsPanel() {
  const t = useStudioT();
  const [draft, setDraft] = useState({ from: "", to: "", name: "" });
  const [applied, setApplied] = useState(draft);
  const qs = new URLSearchParams({ view: "merchants", ...(applied.from ? { from: applied.from } : {}), ...(applied.to ? { to: applied.to } : {}), ...(applied.name.trim() ? { name: applied.name.trim() } : {}) });
  const { data, error } = useSWR<Analytics>(`/api/payees/insights?${qs}`, jsonFetcher, { revalidateOnFocus: false });
  const cur = data?.currency ?? "USD";
  const money = (n: number) => formatCurrency(n, cur);
  const empty = (s: string) => <p className="text-xs text-muted-foreground">{s}</p>;
  const lead = data?.receipt[0];
  const maxBin = Math.max(1, ...(lead?.histogram.map((b) => b.count) ?? [1]));

  return (
    <section className="space-y-4 border-t pt-4" aria-label={t("analytics.title")}>
      <div className="flex flex-wrap items-end gap-2">
        <h3 className="text-sm font-medium mr-auto">{t("analytics.title")}</h3>
        <label className="text-xs">
          {t("analytics.from")}
          <Input type="date" aria-label={t("analytics.fromAria")} className="h-8 w-36" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="text-xs">
          {t("analytics.to")}
          <Input type="date" aria-label={t("analytics.toAria")} className="h-8 w-36" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <label className="text-xs">
          {t("analytics.payee")}
          <Input aria-label={t("analytics.payeeAria")} placeholder={t("analytics.allPayees")} className="h-8 w-44" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <Button size="sm" variant="outline" onClick={() => setApplied(draft)}>
          {t("analytics.show")}
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive">{t("analytics.loadFailed")}</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : (
        <div className="space-y-5 text-sm">
          {data.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t("analytics.truncated", { n: data.scanned.toLocaleString("en-US") })}</p>}

          <div>
            <h4 className="font-medium mb-1">{t("analytics.receipt")}</h4>
            {!data.receipt.length ? empty(t("analytics.noPayments")) : (
              <>
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground"><tr><th className="text-left py-1">{t("analytics.payee")}</th><th className="text-right">{t("analytics.payments")}</th><th className="text-right">{t("analytics.average")}</th><th className="text-right">{t("analytics.median")}</th><th className="text-right">{t("analytics.max")}</th><th className="text-right hidden sm:table-cell">Q1 · Q3</th></tr></thead>
                  <tbody>
                    {data.receipt.map((r) => (
                      <tr key={r.id} className="border-t"><td className="py-1 pr-2">{who(r)}</td><td className="text-right tabular-nums">{r.payments}</td><td className="text-right tabular-nums">{money(r.average)}</td><td className="text-right tabular-nums">{money(r.median)}</td><td className="text-right tabular-nums">{money(r.max)}</td><td className="text-right tabular-nums hidden sm:table-cell">{money(r.quartiles[0])} · {money(r.quartiles[2])}</td></tr>
                    ))}
                  </tbody>
                </table>
                {lead && (
                  <div className="mt-2">
                    <p className="text-xs text-muted-foreground">{t("analytics.sizes", { name: lead.name })}</p>
                    <div className="flex h-20 items-end gap-0.5" role="img" aria-label={t("analytics.histogram", { name: lead.name })}>
                      {lead.histogram.map((b) => (
                        <div key={b.from} className="flex h-full flex-1 items-end" title={`${money(b.from)}–${money(b.to)}: ${b.count}`}>
                          <div className="w-full rounded-t bg-primary/70" style={{ height: `${(b.count / maxBin) * 100}%` }} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">{t("analytics.trend")}</h4>
            {!data.receiptTrend.length ? empty(t("analytics.trendEmpty")) : (
              <ul className="space-y-0.5">
                {data.receiptTrend.map((r) => (
                  <li key={r.id} className="flex gap-2"><span className="min-w-0 flex-1">{who(r)}</span><span className="text-xs text-muted-foreground tabular-nums">{t("analytics.months", { n: r.months.length })} · {r.trendPct == null ? "—" : `${r.trendPct > 0 ? "+" : ""}${r.trendPct}%`}</span></li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">{t("analytics.change", { from2: data.change.period2.from, to2: data.change.period2.to, from1: data.change.period1.from, to1: data.change.period1.to })}</h4>
            <p className="text-xs text-muted-foreground mb-1">
              {t("analytics.changeTotals", { total: money(data.change.totals.total), count: money(data.change.totals.countEffect), receipt: money(data.change.totals.receiptEffect) })}
            </p>
            {!data.change.rows.length ? empty(t("analytics.changeEmpty")) : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground"><tr><th className="text-left py-1">{t("analytics.payee")}</th><th className="text-right">{t("analytics.payments")}</th><th className="text-right">{t("analytics.countEffect")}</th><th className="text-right">{t("analytics.receiptEffect")}</th><th className="text-right">{t("analytics.total")}</th></tr></thead>
                <tbody>
                  {data.change.rows.map((r) => (
                    <tr key={r.id} className="border-t"><td className="py-1 pr-2">{who(r)}</td><td className="text-right tabular-nums">{r.n1} → {r.n2}</td><td className="text-right tabular-nums">{money(r.countEffect)}</td><td className="text-right tabular-nums">{money(r.receiptEffect)}</td><td className="text-right tabular-nums">{money(r.total)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {([
              [t("analytics.new"), data.lifecycle.new.map((r) => [r, t("common.since", { date: r.firstDate })] as const)],
              [t("analytics.quiet"), data.lifecycle.quiet.map((r) => [r, `${t("common.last", { date: r.lastDate })} · ${t("analytics.activeMonths", { n: r.activeMonths })}`] as const)],
              [t("analytics.returned"), data.lifecycle.returned.map((r) => [r, t("analytics.silentMonths", { n: r.silentMonths })] as const)],
              [t("analytics.churned"), data.lifecycle.churned.map((r) => [r, t("common.last", { date: r.lastDate })] as const)],
            ] as const).map(([title, rows]) => (
              <div key={title}>
                <h4 className="font-medium mb-1">{title}</h4>
                {!rows.length ? empty(t("analytics.none")) : (
                  <ul className="space-y-0.5">{rows.map(([r, text]) => <li key={r.id} className="flex gap-2"><span className="min-w-0 flex-1">{who(r)}</span><span className="text-xs text-muted-foreground">{text}</span></li>)}</ul>
                )}
              </div>
            ))}
          </div>

          <div>
            <h4 className="font-medium mb-1">{t("analytics.regular")}</h4>
            {!data.regular.length ? empty(t("analytics.noRegular")) : (
              <ul className="divide-y rounded-lg border">
                {data.regular.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-x-3 p-2"><span className="min-w-0 flex-1">{who(r)}</span><span className="text-xs text-muted-foreground">{t("analytics.every", { n: r.intervalDays })} · {money(r.average)} · {t("analytics.perYear", { amount: money(r.yearlyCost) })} · {t("common.next", { date: r.nextExpected })}</span></li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">{t("analytics.multiCategory")}</h4>
            {!data.multiCategory.length ? empty(t("analytics.noMultiCategory")) : (
              <ul className="space-y-1">
                {data.multiCategory.map((r) => (
                  <li key={r.id}>
                    <span>{who(r)}</span>{" "}
                    <span className="text-xs text-muted-foreground">{r.categories.map((c) => `${c.name} ${pct(c.share)}`).join(" · ")}</span>
                    <p className="text-xs text-muted-foreground">{r.hint} <Link className="underline" href="/settings/rules">{t("analytics.rules")}</Link></p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">{t("analytics.businessPersonal")}</h4>
            {!data.businessPersonal.length ? empty(t("analytics.noBusinessPersonal")) : (
              <ul className="space-y-0.5">
                {data.businessPersonal.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-2">
                    <span className="min-w-0 flex-1">{who(r)}</span>
                    <span className="text-xs text-muted-foreground">{t("analytics.businessSplit", { business: r.business, personal: r.personal, share: pct(r.businessShare) })}</span>
                    <Link className="text-xs underline" href={buildTxDrillUrl({ search: r.name })}>{t("common.transactions")}</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">{t("analytics.people")}</h4>
            {!data.people.length ? empty(t("analytics.noPeople")) : (
              <ul className="space-y-2">
                {data.people.map((r) => (
                  <li key={r.id} className="rounded-lg border p-2">
                    <div className="flex flex-wrap gap-2"><span className="min-w-0 flex-1 font-medium">{who(r)}</span><span className="text-xs tabular-nums">{t("analytics.peopleTotals", { paid: money(r.paid), received: money(r.received), net: money(r.net) })}</span></div>
                    <ul className="mt-1 text-xs text-muted-foreground">
                      {r.byPurpose.map((p) => <li key={p.purpose} className="flex gap-2"><span className="flex-1">{p.purpose}</span><span className="tabular-nums">{p.paid ? t("analytics.paid", { amount: money(p.paid) }) : ""}{p.paid && p.received ? " · " : ""}{p.received ? t("analytics.received", { amount: money(p.received) }) : ""}</span></li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
