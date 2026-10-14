"use client";

/**
 * Merchants → Overview cards (P8 stage 2): coverage with a bar, top-5
 * uncovered payees, new merchants, large checks, duplicates, silent
 * subscriptions, untyped and to-check entries, for 30 days / 90 days / a
 * year. Channels, own transfers and bank operations are never in the tops.
 * Above them: a one-time «Що тут є» hint and the 3-step «Старт».
 */

import { useEffect, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/i18n/format-current";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import type { OverviewCards as Cards, OverviewPeriod } from "@/lib/payees/overview-cards";
import { useT } from "@/lib/i18n/client";

const PERIOD_KEY: Record<OverviewPeriod, "overview.period.30d" | "overview.period.90d" | "overview.period.1y"> = {
  "30d": "overview.period.30d",
  "90d": "overview.period.90d",
  "1y": "overview.period.1y",
};
export const CADENCE_KEY: Record<string, "insights.cadence.weekly" | "insights.cadence.biweekly" | "insights.cadence.monthly" | "insights.cadence.quarterly" | "insights.cadence.yearly"> = {
  weekly: "insights.cadence.weekly",
  biweekly: "insights.cadence.biweekly",
  monthly: "insights.cadence.monthly",
  quarterly: "insights.cadence.quarterly",
  yearly: "insights.cadence.yearly",
};
export const INTRO_SEEN_KEY = "finlynq.merchants.introSeen";

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function Card({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-lg border p-3 space-y-2 min-w-0" data-testid={testId}>
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

const nameOf = (x: { name: string; entityId: number | null }) =>
  x.entityId != null ? <Link href={`/merchants/${x.entityId}`} className="hover:underline break-all">{x.name}</Link> : <span className="break-all">{x.name}</span>;

export type StartState = { hasDirectory: boolean; typedAll: boolean; hintOn: boolean };

export function MerchantsOverviewCards({ start, onOpen }: { start: StartState; onOpen: (target: "queue" | "untyped" | "settings" | "suspicious") => void }) {
  const t = useT();
  const [period, setPeriod] = useState<OverviewPeriod>("90d");
  const [introSeen, setIntroSeen] = useState(true);
  useEffect(() => setIntroSeen(readFlag(INTRO_SEEN_KEY)), []);
  const { data: raw, error } = useSWR<Cards>(`/api/payees/overview-cards?period=${period}`, jsonFetcher, { revalidateOnFocus: false });
  const data = raw && typeof raw === "object" && "coverage" in raw ? raw : undefined;
  const cur = data?.currency ?? "USD";
  const money = (n: number) => formatCurrency(n, cur, { compact: Math.abs(n) >= 10_000 });
  const steps: Array<{ done: boolean; label: string; go: () => void }> = [
    { done: start.hasDirectory, label: t("overview.start.queue"), go: () => onOpen("queue") },
    { done: start.typedAll, label: t("overview.start.types"), go: () => onOpen("untyped") },
    { done: start.hintOn, label: t("overview.start.hint"), go: () => onOpen("settings") },
  ];

  return (
    <div className="space-y-3">
      {!introSeen && (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1" role="note">
          <p className="font-medium">{t("overview.intro.title")}</p>
          <p className="text-muted-foreground">{t("overview.intro.body")}</p>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => {
              setIntroSeen(true);
              try {
                window.localStorage.setItem(INTRO_SEEN_KEY, "1");
              } catch {
                /* private mode: the hint just shows again */
              }
            }}
          >
            {t("overview.intro.dismiss")}
          </Button>
        </div>
      )}
      {steps.some((s) => !s.done) && (
        <ol className="rounded-lg border p-3 text-sm space-y-1" aria-label={t("overview.start.title")}>
          <li className="font-medium list-none">{t("overview.start.title")}</li>
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2 list-none">
              <span aria-hidden className={s.done ? "text-emerald-600" : "text-muted-foreground"}>{s.done ? "✓" : `${i + 1}.`}</span>
              <button type="button" className={`text-start hover:underline ${s.done ? "text-muted-foreground line-through" : ""}`} onClick={s.go}>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("overview.periodLabel")}>
        {(Object.keys(PERIOD_KEY) as OverviewPeriod[]).map((p) => (
          <Button key={p} size="sm" variant={p === period ? "default" : "outline"} className="h-7 text-xs" aria-pressed={p === period} onClick={() => setPeriod(p)}>
            {t(PERIOD_KEY[p])}
          </Button>
        ))}
      </div>

      {error && !data && <p className="text-sm text-destructive">{t("overview.loadFailed")}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
      {data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Card title={t("overview.coverage")} testId="card-coverage">
            <p className="text-2xl font-semibold tabular-nums">{data.coverage.pct}%</p>
            <div className="h-2 rounded bg-muted overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={data.coverage.pct} aria-label={t("overview.coverage")}>
              <div className="h-full bg-primary" style={{ width: `${Math.min(100, data.coverage.pct)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{t("overview.coverageDetail", { covered: data.coverage.covered, rows: data.coverage.rows })}</p>
          </Card>

          <Card title={t("overview.topUncovered")} testId="card-uncovered">
            {data.topUncovered.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("overview.nothing")}</p>
            ) : (
              <ul className="text-sm space-y-0.5">
                {data.topUncovered.map((u) => (
                  <li key={u.name} className="flex gap-2">
                    <span className="truncate flex-1">{u.name}</span>
                    <span className="tabular-nums text-muted-foreground">{money(-u.spend)}</span>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="text-xs underline" onClick={() => onOpen("queue")}>{t("overview.toQueue")}</button>
          </Card>

          <Card title={t("overview.newMerchants")} testId="card-new">
            {data.newMerchants.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("overview.nothing")}</p>
            ) : (
              <ul className="text-sm space-y-0.5">
                {data.newMerchants.map((n) => (
                  <li key={n.id} className="flex gap-2">
                    <span className="truncate flex-1">{nameOf(n)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{t("common.since", { date: formatDate(n.firstDate) })}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t("overview.largeChecks")} testId="card-large">
            {data.largeChecks.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("overview.nothing")}</p>
            ) : (
              <ul className="text-sm space-y-0.5">
                {data.largeChecks.map((l) => (
                  <li key={l.txId} className="flex gap-2" title={t("overview.largeTitle", { threshold: money(-l.threshold) })}>
                    <span className="truncate flex-1">{nameOf(l)}</span>
                    <span className="tabular-nums">{money(l.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{t("overview.largeHelp")}</p>
          </Card>

          <Card title={t("overview.duplicates", { n: data.duplicates.count })} testId="card-duplicates">
            {data.duplicates.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("overview.nothing")}</p>
            ) : (
              <ul className="text-sm space-y-0.5">
                {data.duplicates.items.map((d) => (
                  <li key={`${d.id}-${d.date}-${d.amount}`} className="flex gap-2">
                    <Link href={buildTxDrillUrl({ search: d.name, startDate: d.date, endDate: d.date })} className="truncate flex-1 hover:underline">{d.name}</Link>
                    <span className="text-xs text-muted-foreground tabular-nums">{formatDate(d.date)} · {d.txIds.length}× {money(d.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t("overview.silent")} testId="card-silent">
            {data.silent.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("overview.nothing")}</p>
            ) : (
              <ul className="text-sm space-y-0.5">
                {data.silent.map((s) => (
                  <li key={s.id} className="flex gap-2">
                    <span className="truncate flex-1">{nameOf(s)}</span>
                    <span className="text-xs text-muted-foreground">
                      {CADENCE_KEY[s.cadence] ? t(CADENCE_KEY[s.cadence]) : ""} · {t("common.last", { date: formatDate(s.lastDate) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t("overview.directoryHealth")} testId="card-health">
            <button type="button" className="block text-sm hover:underline" onClick={() => onOpen("untyped")}>{t("overview.untyped", { n: data.untyped })}</button>
            <button type="button" className="block text-sm hover:underline" onClick={() => onOpen("suspicious")}>{t("overview.suspicious")}</button>
          </Card>
        </div>
      )}
      {data?.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t("overview.truncated")}</p>}
    </div>
  );
}
