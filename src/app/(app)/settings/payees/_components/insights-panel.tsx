"use client";

/**
 * Payee insights (GET /api/payees/insights): concentration, top counterparties
 * by spend and by count, monthly spend (one series: bars with a hover title,
 * values also in the table below), new / gone counterparties and regular
 * ones with their typical interval and next expected date.
 */

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { formatCurrency } from "@/lib/currency";

type Cp = { id: string; name: string; entityId: number | null; count: number; total: number; spend: number; firstDate: string | null; lastDate: string | null };
type Insights = {
  currency: string;
  window: { months: number; from: string };
  totals: { counterparties: number; transactions: number; spend: number; income: number };
  topBySpend: Cp[];
  topByCount: Cp[];
  monthly: { months: string[]; series: Array<{ id: string; name: string; values: number[] }> };
  newCounterparties: Cp[];
  goneCounterparties: Array<Cp & { expectedEveryDays: number; daysSilent: number }>;
  recurring: Array<Cp & { intervalDays: number; cadence: string; nextExpected: string; typicalAmount: number }>;
  concentration: { top5Share: number; top10Share: number; hhi: number; label: string };
};

const name = (c: Cp) =>
  c.entityId != null ? (
    <Link href={`/settings/payees/${c.entityId}`} className="hover:underline break-all">{c.name}</Link>
  ) : (
    <span className="break-all">{c.name}</span>
  );

export function InsightsPanel() {
  const [months, setMonths] = useState(12);
  const { data, error } = useSWR<Insights>(`/api/payees/insights?months=${months}`, jsonFetcher, { revalidateOnFocus: false });
  if (error) return <p className="text-sm text-destructive">Couldn&apos;t load insights.</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const cur = data.currency;
  const spendByMonth = data.monthly.months.map((_, i) => Math.max(0, -data.monthly.series.reduce((n, s) => n + s.values[i], 0)));
  const max = Math.max(1, ...spendByMonth);
  const list = (title: string, rows: Cp[], value: (c: Cp) => string, empty: string) => (
    <div>
      <h3 className="text-sm font-medium mb-1">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ol className="text-sm space-y-0.5">
          {rows.map((c) => (
            <li key={c.id} className="flex gap-2">
              <span className="min-w-0 flex-1">{name(c)}</span>
              <span className="tabular-nums text-muted-foreground whitespace-nowrap">{value(c)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-2">
          Window
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[3, 6, 12, 24].map((m) => (
              <option key={m} value={m}>Last {m} months</option>
            ))}
          </select>
        </label>
        <span className="text-muted-foreground">
          {data.totals.counterparties} counterparties · {data.totals.transactions} tx · spent {formatCurrency(data.totals.spend, cur)}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Top 5 share of spend</p>
          <p className="text-2xl font-semibold tabular-nums">{Math.round(data.concentration.top5Share * 100)}%</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Top 10 share of spend</p>
          <p className="text-2xl font-semibold tabular-nums">{Math.round(data.concentration.top10Share * 100)}%</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Concentration (HHI)</p>
          <p className="text-2xl font-semibold tabular-nums">{data.concentration.hhi}</p>
          <p className="text-xs text-muted-foreground capitalize">{data.concentration.label}</p>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Spend per month ({cur})</h3>
        <div className="flex h-28 items-end gap-0.5" role="img" aria-label="Spend per month; values in the table below">
          {spendByMonth.map((v, i) => (
            <div key={data.monthly.months[i]} className="flex-1 min-w-0 h-full flex items-end" title={`${data.monthly.months[i]}: ${formatCurrency(v, cur)}`}>
              <div className="w-full rounded-t bg-primary/70 hover:bg-primary" style={{ height: `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
          <span>{data.monthly.months[0]}</span>
          <span>{data.monthly.months[data.monthly.months.length - 1]}</span>
        </div>
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left py-1 pr-2">Counterparty</th>
                {data.monthly.months.map((m) => (
                  <th key={m} className="text-right py-1 px-1 whitespace-nowrap">{m.slice(2)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.monthly.series.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="py-1 pr-2 max-w-40 truncate">{s.name}</td>
                  {s.values.map((v, i) => (
                    <td key={i} className="text-right py-1 px-1 tabular-nums">{v ? Math.round(v) : "·"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        {list("Top by spend", data.topBySpend, (c) => formatCurrency(c.spend, cur), "No spending in this window.")}
        {list("Top by number of transactions", data.topByCount, (c) => `${c.count} tx`, "No transactions in this window.")}
        {list("New counterparties", data.newCounterparties, (c) => `since ${c.firstDate ?? "—"}`, "Nobody new recently.")}
        {list("Gone quiet", data.goneCounterparties, (c) => `last ${c.lastDate ?? "—"}`, "No regular counterparty has gone quiet.")}
      </div>

      <div>
        <h3 className="text-sm font-medium mb-1">Regular counterparties</h3>
        {data.recurring.length === 0 ? (
          <p className="text-xs text-muted-foreground">No regular pattern found.</p>
        ) : (
          <ul className="text-sm divide-y rounded-lg border">
            {data.recurring.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-3 gap-y-0.5 p-2">
                <span className="min-w-0 flex-1">{name(r)}</span>
                <span className="text-xs text-muted-foreground">
                  {r.cadence.replace("irregular-regular", "every")} · ~{r.intervalDays} days · {formatCurrency(r.typicalAmount, cur)} · next ~{r.nextExpected}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
