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
    <section className="space-y-4 border-t pt-4" aria-label="Merchant analyses">
      <div className="flex flex-wrap items-end gap-2">
        <h3 className="text-sm font-medium mr-auto">Merchant analyses</h3>
        <label className="text-xs">
          From
          <Input type="date" aria-label="Analyses from" className="h-8 w-36" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="text-xs">
          To
          <Input type="date" aria-label="Analyses to" className="h-8 w-36" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <label className="text-xs">
          Payee
          <Input aria-label="Analyses payee" placeholder="All payees" className="h-8 w-44" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <Button size="sm" variant="outline" onClick={() => setApplied(draft)}>
          Show
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive">Couldn&apos;t load the analyses.</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-5 text-sm">
          {data.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">Very large ledger: only the first {data.scanned.toLocaleString("en-US")} transactions were analysed.</p>}

          <div>
            <h4 className="font-medium mb-1">1. Receipt (payment size)</h4>
            {!data.receipt.length ? empty("No payments.") : (
              <>
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground"><tr><th className="text-left py-1">Payee</th><th className="text-right">Payments</th><th className="text-right">Average</th><th className="text-right">Median</th><th className="text-right">Max</th><th className="text-right hidden sm:table-cell">Q1 · Q3</th></tr></thead>
                  <tbody>
                    {data.receipt.map((r) => (
                      <tr key={r.id} className="border-t"><td className="py-1 pr-2">{who(r)}</td><td className="text-right tabular-nums">{r.payments}</td><td className="text-right tabular-nums">{money(r.average)}</td><td className="text-right tabular-nums">{money(r.median)}</td><td className="text-right tabular-nums">{money(r.max)}</td><td className="text-right tabular-nums hidden sm:table-cell">{money(r.quartiles[0])} · {money(r.quartiles[2])}</td></tr>
                    ))}
                  </tbody>
                </table>
                {lead && (
                  <div className="mt-2">
                    <p className="text-xs text-muted-foreground">Payment sizes — {lead.name}</p>
                    <div className="flex h-20 items-end gap-0.5" role="img" aria-label={`Histogram of payment sizes for ${lead.name}`}>
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
            <h4 className="font-medium mb-1">2. Receipt trend</h4>
            {!data.receiptTrend.length ? empty("Not enough payments (3+ needed).") : (
              <ul className="space-y-0.5">
                {data.receiptTrend.map((r) => (
                  <li key={r.id} className="flex gap-2"><span className="min-w-0 flex-1">{who(r)}</span><span className="text-xs text-muted-foreground tabular-nums">{r.months.length} months · {r.trendPct == null ? "—" : `${r.trendPct > 0 ? "+" : ""}${r.trendPct}%`}</span></li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">3. What changed: {data.change.period2.from} – {data.change.period2.to} vs {data.change.period1.from} – {data.change.period1.to}</h4>
            <p className="text-xs text-muted-foreground mb-1">
              Total {money(data.change.totals.total)} = more / fewer payments {money(data.change.totals.countEffect)} + bigger / smaller payments {money(data.change.totals.receiptEffect)}
            </p>
            {!data.change.rows.length ? empty("No payments in either period.") : (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground"><tr><th className="text-left py-1">Payee</th><th className="text-right">Payments</th><th className="text-right">Count effect</th><th className="text-right">Receipt effect</th><th className="text-right">Total</th></tr></thead>
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
              ["4a. New", data.lifecycle.new.map((r) => [r, `since ${r.firstDate}`] as const)],
              ["4b. Gone quiet", data.lifecycle.quiet.map((r) => [r, `last ${r.lastDate} · ${r.activeMonths} of 6 months before`] as const)],
              ["4c. Back again", data.lifecycle.returned.map((r) => [r, `after ${r.silentMonths} silent months`] as const)],
              ["4d. Churned", data.lifecycle.churned.map((r) => [r, `last ${r.lastDate}`] as const)],
            ] as const).map(([title, rows]) => (
              <div key={title}>
                <h4 className="font-medium mb-1">{title}</h4>
                {!rows.length ? empty("None.") : (
                  <ul className="space-y-0.5">{rows.map(([r, t]) => <li key={r.id} className="flex gap-2"><span className="min-w-0 flex-1">{who(r)}</span><span className="text-xs text-muted-foreground">{t}</span></li>)}</ul>
                )}
              </div>
            ))}
          </div>

          <div>
            <h4 className="font-medium mb-1">5. Regular payments</h4>
            {!data.regular.length ? empty("No regular pattern.") : (
              <ul className="divide-y rounded-lg border">
                {data.regular.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-x-3 p-2"><span className="min-w-0 flex-1">{who(r)}</span><span className="text-xs text-muted-foreground">every ~{r.intervalDays} days · {money(r.average)} · {money(r.yearlyCost)} a year · next ~{r.nextExpected}</span></li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">6. Several categories</h4>
            {!data.multiCategory.length ? empty("Every payee keeps to one category.") : (
              <ul className="space-y-1">
                {data.multiCategory.map((r) => (
                  <li key={r.id}>
                    <span>{who(r)}</span>{" "}
                    <span className="text-xs text-muted-foreground">{r.categories.map((c) => `${c.name} ${pct(c.share)}`).join(" · ")}</span>
                    <p className="text-xs text-muted-foreground">{r.hint} <Link className="underline" href="/settings/rules">Rules</Link></p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">7. Business and personal</h4>
            {!data.businessPersonal.length ? empty("No payee is both business and personal.") : (
              <ul className="space-y-0.5">
                {data.businessPersonal.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-2">
                    <span className="min-w-0 flex-1">{who(r)}</span>
                    <span className="text-xs text-muted-foreground">{r.business} business · {r.personal} personal ({pct(r.businessShare)} business)</span>
                    <Link className="text-xs underline" href={buildTxDrillUrl({ search: r.name })}>Transactions</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="font-medium mb-1">8. People: paid and received</h4>
            {!data.people.length ? empty("No private persons or sole proprietors.") : (
              <ul className="space-y-2">
                {data.people.map((r) => (
                  <li key={r.id} className="rounded-lg border p-2">
                    <div className="flex flex-wrap gap-2"><span className="min-w-0 flex-1 font-medium">{who(r)}</span><span className="text-xs tabular-nums">paid {money(r.paid)} · received {money(r.received)} · net {money(r.net)}</span></div>
                    <ul className="mt-1 text-xs text-muted-foreground">
                      {r.byPurpose.map((p) => <li key={p.purpose} className="flex gap-2"><span className="flex-1">{p.purpose}</span><span className="tabular-nums">{p.paid ? `paid ${money(p.paid)}` : ""}{p.paid && p.received ? " · " : ""}{p.received ? `received ${money(p.received)}` : ""}</span></li>)}
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
