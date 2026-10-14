/**
 * The Merchants overview cards (P8 stage 2), for the last 30 days, 90 days
 * or year. One keyset scan of `transactions` (read only), every payee
 * resolved through the directory matcher:
 *
 *   - coverage:       share of rows (and of spend) whose payee resolves to a
 *                     directory entry; channels, own transfers and the bank's
 *                     service rows are left out of the count
 *   - topUncovered:   the 5 unresolved payees with the most spend
 *   - newMerchants:   counterparties first seen inside the period
 *   - largeChecks:    payments above Q3 + 1.5·IQR of the SAME counterparty's
 *                     earlier payments — only when it has at least 4 of them
 *                     (no new analysis: the existing quartiles, nothing else)
 *   - duplicates:     same counterparty, same day, same amount, twice or more
 *   - silent:         regular payments (≥ 3, regular intervals) that missed
 *                     two intervals — a subscription that stopped, or moved
 *   - untyped / suspicious: directory entries without a merchant type / to
 *                     check (counts; the queue has the lists)
 *
 * Channels (`OTPC2C`, `P24`…), own transfers and bank operations never
 * appear in the tops. Money is in the display currency (`convert`).
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { payeeMatchKey } from "./match-key";
import { addSlice, decodeStoredPayee, spellingOf, type AmountSlice, type PayeeExecutor } from "./scan";
import type { PayeeMatcher } from "./directory";
import { bankOperationOf, channelOf, type PayeeVocabulary } from "./type-words";
import type { OwnMatcher } from "./own-accounts";
import { detectRecurrence } from "./insights";
import { quantile } from "./merchant-analytics";

export const OVERVIEW_PERIODS = ["30d", "90d", "1y"] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];

type Ref = { id: string; name: string; entityId: number | null };
export type OverviewCards = {
  period: OverviewPeriod;
  from: string;
  to: string;
  currency: string;
  coverage: { rows: number; covered: number; pct: number; spend: number; coveredSpend: number };
  topUncovered: Array<{ name: string; count: number; spend: number }>;
  newMerchants: Array<Ref & { firstDate: string; count: number; spend: number }>;
  largeChecks: Array<Ref & { txId: number; date: string; amount: number; threshold: number }>;
  duplicates: { count: number; items: Array<Ref & { date: string; amount: number; txIds: number[] }> };
  silent: Array<Ref & { cadence: string; intervalDays: number; lastDate: string; daysSilent: number }>;
  untyped: number;
  truncated: boolean;
};

const PAGE = 5_000;
const MAX_SCAN = 200_000;
const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`);

export function periodStart(period: OverviewPeriod, today: string): string {
  const days = period === "30d" ? 30 : period === "90d" ? 90 : 365;
  return new Date(toDay(today) - (days - 1) * DAY).toISOString().slice(0, 10);
}

type Cp = Ref & {
  firstDate: string;
  dates: string[];
  /** Outflows before the period (absolute, display currency) — the quartile base. */
  before: number[];
  inCount: number;
  inSpend: number;
  spellings: Map<string, number>;
};

export async function computeOverviewCards(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  matcher: PayeeMatcher;
  own: OwnMatcher;
  vocab?: PayeeVocabulary;
  convert: (slices: AmountSlice[]) => number;
  currency: string;
  period: OverviewPeriod;
  today?: string;
}): Promise<OverviewCards> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const from = periodStart(opts.period, today);
  const cps = new Map<string, Cp>();
  const inWindow: Array<{ id: number; cp: string; date: string; amount: number; abs: number }> = [];
  const coverage = { rows: 0, covered: 0, pct: 0, spend: 0, coveredSpend: 0 };
  const uncovered = new Map<string, { name: string; count: number; spend: number }>();
  let after = 0;
  let scanned = 0;
  let truncated = false;
  for (;;) {
    const page = normalizeDbRows<Record<string, unknown>>(
      await opts.executor.execute(sql`
        SELECT id, date, amount, currency, reporting_amount, reporting_currency, payee
        FROM transactions WHERE user_id = ${opts.userId} AND id > ${after} ORDER BY id LIMIT ${PAGE}`),
    );
    for (const r of page) {
      after = Number(r.id);
      const plain = decodeStoredPayee(r.payee, null, opts.dek);
      if (plain === undefined) continue;
      const spelling = spellingOf(plain);
      const date = String(r.date ?? "").slice(0, 10);
      if (!spelling || !date || date > today) continue;
      if (channelOf(spelling) || bankOperationOf(spelling, opts.vocab) || opts.own.inText(spelling)) continue;
      const one = new Map<string, AmountSlice>();
      addSlice(one, Number(r.amount ?? 0), r.currency == null ? null : String(r.currency), r.reporting_amount == null ? null : Number(r.reporting_amount), r.reporting_currency == null ? null : String(r.reporting_currency));
      const amount = opts.convert([...one.values()]);
      const m = opts.matcher.match(spelling);
      const key = payeeMatchKey(spelling);
      const id = m.kind === "match" ? `e:${m.entityId}` : key ? `k:${key}` : null;
      if (!id) continue;
      let cp = cps.get(id);
      if (!cp) {
        cp = { id, name: m.kind === "match" ? m.name : spelling, entityId: m.kind === "match" ? m.entityId : null, firstDate: date, dates: [], before: [], inCount: 0, inSpend: 0, spellings: new Map() };
        cps.set(id, cp);
      }
      if (date < cp.firstDate) cp.firstDate = date;
      if (amount < 0) cp.dates.push(date);
      if (m.kind !== "match") cp.spellings.set(spelling, (cp.spellings.get(spelling) ?? 0) + 1);
      if (date < from) {
        if (amount < 0) cp.before.push(-amount);
        continue;
      }
      cp.inCount++;
      if (amount < 0) cp.inSpend += -amount;
      inWindow.push({ id: after, cp: id, date, amount, abs: Math.abs(amount) });
      coverage.rows++;
      if (amount < 0) coverage.spend += -amount;
      if (m.kind === "match") {
        coverage.covered++;
        if (amount < 0) coverage.coveredSpend += -amount;
      } else if (m.kind === "none") {
        const u = uncovered.get(id) ?? { name: spelling, count: 0, spend: 0 };
        u.count++;
        if (amount < 0) u.spend += -amount;
        uncovered.set(id, u);
      }
    }
    scanned += page.length;
    if (page.length < PAGE) break;
    if (scanned >= MAX_SCAN) {
      truncated = true;
      break;
    }
  }
  coverage.pct = coverage.rows ? Math.round((coverage.covered / coverage.rows) * 1000) / 10 : 0;
  coverage.spend = round2(coverage.spend);
  coverage.coveredSpend = round2(coverage.coveredSpend);
  // A key-group's name is its most used spelling.
  for (const cp of cps.values()) {
    if (cp.entityId == null && cp.spellings.size) cp.name = [...cp.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }
  for (const [id, u] of uncovered) u.name = cps.get(id)?.name ?? u.name;
  const ref = (cp: Cp): Ref => ({ id: cp.id, name: cp.name, entityId: cp.entityId });

  const topUncovered = [...uncovered.values()]
    .filter((u) => u.spend > 0)
    .sort((a, b) => b.spend - a.spend || b.count - a.count)
    .slice(0, 5)
    .map((u) => ({ ...u, spend: round2(u.spend) }));

  const newMerchants = [...cps.values()]
    .filter((cp) => cp.firstDate >= from && cp.inCount > 0)
    .sort((a, b) => b.inSpend - a.inSpend || b.inCount - a.inCount)
    .slice(0, 5)
    .map((cp) => ({ ...ref(cp), firstDate: cp.firstDate, count: cp.inCount, spend: round2(cp.inSpend) }));

  // Large checks: Q3 + 1.5·IQR of the counterparty's own earlier payments (≥ 4).
  const thresholds = new Map<string, number>();
  for (const cp of cps.values()) {
    if (cp.before.length < 4) continue;
    const s = [...cp.before].sort((a, b) => a - b);
    const q1 = quantile(s, 0.25);
    const q3 = quantile(s, 0.75);
    thresholds.set(cp.id, q3 + 1.5 * (q3 - q1));
  }
  const largeChecks = inWindow
    .filter((x) => x.amount < 0 && thresholds.has(x.cp) && x.abs > thresholds.get(x.cp)! + 0.005)
    .sort((a, b) => b.abs - a.abs)
    .slice(0, 5)
    .map((x) => ({ ...ref(cps.get(x.cp)!), txId: x.id, date: x.date, amount: round2(x.amount), threshold: round2(thresholds.get(x.cp)!) }));

  // Duplicates: same counterparty + day + amount.
  const dupes = new Map<string, { cp: string; date: string; amount: number; txIds: number[] }>();
  for (const x of inWindow) {
    if (x.amount >= 0) continue;
    const k = `${x.cp}|${x.date}|${round2(x.amount)}`;
    const d = dupes.get(k) ?? { cp: x.cp, date: x.date, amount: round2(x.amount), txIds: [] };
    d.txIds.push(x.id);
    dupes.set(k, d);
  }
  const dupList = [...dupes.values()].filter((d) => d.txIds.length > 1).sort((a, b) => b.date.localeCompare(a.date));
  const duplicates = { count: dupList.length, items: dupList.slice(0, 5).map((d) => ({ ...ref(cps.get(d.cp)!), date: d.date, amount: d.amount, txIds: d.txIds })) };

  // Silent: regular payments that missed two intervals (seen within the last ~13 months).
  const silent: OverviewCards["silent"] = [];
  const now = toDay(today);
  for (const cp of cps.values()) {
    const rec = detectRecurrence(cp.dates);
    if (!rec || rec.cadence === "irregular-regular") continue;
    const daysSilent = Math.round((now - toDay(rec.last)) / DAY);
    if (daysSilent > 2 * rec.intervalDays && daysSilent <= 400) silent.push({ ...ref(cp), cadence: rec.cadence, intervalDays: rec.intervalDays, lastDate: rec.last, daysSilent });
  }
  silent.sort((a, b) => a.daysSilent - b.daysSilent);

  return {
    period: opts.period,
    from,
    to: today,
    currency: opts.currency,
    coverage,
    topUncovered,
    newMerchants,
    largeChecks,
    duplicates,
    silent: silent.slice(0, 5),
    untyped: opts.matcher.entities.filter((e) => e.merchantTypeId == null).length,
    truncated,
  };
}
