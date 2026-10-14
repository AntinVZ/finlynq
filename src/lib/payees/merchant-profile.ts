/**
 * The numbers on a merchant's page (P8 stage 1): the last 12 months of the
 * transactions resolving to one directory entry — sum, count, average
 * payment, last date, a monthly series for the sparkline — and its most
 * recent transactions. Amounts are converted to the display currency the
 * way the overview converts them (reporting amount first); the recent rows
 * keep their own currency. Read only.
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { payeeMatchKey } from "./match-key";
import { addSlice, decodeStoredPayee, spellingOf, type AmountSlice, type PayeeExecutor } from "./scan";
import { detectRecurrence } from "./insights";
import { quantile } from "./merchant-analytics";

export type MerchantKpis = {
  currency: string;
  window: { from: string; to: string; months: number };
  /** Signed sum over the window in the display currency. */
  total: number;
  /** Net outflow (−total when negative, else 0). */
  spend: number;
  count: number;
  /** Average absolute payment in the display currency (0 without rows). */
  average: number;
  lastDate: string | null;
  /** One value per month of the window, oldest first (signed, display currency). */
  months: Array<{ month: string; total: number }>;
  recent: Array<{ id: number; date: string; amount: number; currency: string | null; account: string | null; category: string | null; payee: string }>;
  /** P8 stage 10: rows of this entry with no category yet (any date) — «apply the default category to N». */
  uncategorized: number;
  /**
   * P8 stage 2: what stands out over the window, from the entry's own rows
   * only — a regular cadence and the next expected date, the typical payment
   * range (Q1–Q3) and how many payments were above Q3 + 1.5·IQR. Null when
   * there are too few rows to say anything.
   */
  insights: {
    cadence: string | null;
    intervalDays: number | null;
    nextExpected: string | null;
    typicalLow: number;
    typicalHigh: number;
    largeCount: number;
    largeThreshold: number;
  } | null;
  /** Stopped at the scan limit. */
  truncated: boolean;
};

const PAGE = 5_000;
const MAX_SCAN = 200_000;

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function monthsBack(today: string, n: number): string[] {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function loadMerchantKpis(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  /** Matching keys of the spellings that resolve to the entry. */
  keys: ReadonlySet<string>;
  convert: (slices: AmountSlice[]) => number;
  currency: string;
  names: { accounts: Map<number, string>; categories: Map<number, string> };
  months?: number;
  recent?: number;
  today?: string;
}): Promise<MerchantKpis> {
  const monthsN = opts.months ?? 12;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const window = monthsBack(today, monthsN);
  const from = `${window[0]}-01`;
  const byMonth = new Map<string, Map<string, AmountSlice>>(window.map((m) => [m, new Map()]));
  const perRow: number[] = [];
  const rowDates: string[] = [];
  let count = 0;
  let lastDate: string | null = null;
  type Recent = MerchantKpis["recent"][number];
  const recent: Recent[] = [];
  const recentN = opts.recent ?? 15;
  let after = 0;
  let scanned = 0;
  let truncated = false;
  let uncategorized = 0;
  if (opts.keys.size) {
    for (;;) {
      const page = normalizeDbRows<Record<string, unknown>>(
        await opts.executor.execute(sql`
          SELECT id, date, amount, currency, reporting_amount, reporting_currency, account_id, category_id, payee
          FROM transactions WHERE user_id = ${opts.userId} AND id > ${after} ORDER BY id LIMIT ${PAGE}`),
      );
      for (const r of page) {
        after = Number(r.id);
        const payee = decodeStoredPayee(r.payee, null, opts.dek);
        if (payee === undefined) continue;
        const spelling = spellingOf(payee);
        if (!spelling || !opts.keys.has(payeeMatchKey(spelling))) continue;
        const date = String(r.date ?? "").slice(0, 10);
        const amount = Number(r.amount ?? 0);
        const currency = r.currency == null ? null : String(r.currency);
        if (!lastDate || date > lastDate) lastDate = date;
        if (r.category_id == null) uncategorized++;
        const rec: Recent = {
          id: Number(r.id),
          date,
          amount,
          currency,
          account: r.account_id == null ? null : (opts.names.accounts.get(Number(r.account_id)) ?? null),
          category: r.category_id == null ? null : (opts.names.categories.get(Number(r.category_id)) ?? null),
          payee: spelling,
        };
        if (recent.length < recentN || date > recent[recent.length - 1].date) {
          recent.push(rec);
          recent.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
          if (recent.length > recentN) recent.pop();
        }
        if (date < from || date > today) continue;
        const slices = byMonth.get(monthOf(date));
        if (!slices) continue;
        const reporting = r.reporting_amount == null ? null : Number(r.reporting_amount);
        const reportingCurrency = r.reporting_currency == null ? null : String(r.reporting_currency);
        addSlice(slices, amount, currency, reporting, reportingCurrency);
        const one = new Map<string, AmountSlice>();
        addSlice(one, amount, currency, reporting, reportingCurrency);
        perRow.push(Math.abs(opts.convert([...one.values()])));
        rowDates.push(date);
        count++;
      }
      scanned += page.length;
      if (page.length < PAGE) break;
      if (scanned >= MAX_SCAN) {
        truncated = true;
        break;
      }
    }
  }
  const months = window.map((m) => ({ month: m, total: round2(opts.convert([...(byMonth.get(m)?.values() ?? [])])) }));
  const total = round2(months.reduce((n, m) => n + m.total, 0));
  return {
    currency: opts.currency,
    window: { from, to: today, months: monthsN },
    total,
    spend: total < 0 ? round2(-total) : 0,
    count,
    average: count ? round2(perRow.reduce((n, v) => n + v, 0) / count) : 0,
    lastDate,
    months,
    recent,
    uncategorized,
    insights: merchantInsights(perRow, rowDates),
    truncated,
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** See `MerchantKpis.insights`. Exported for tests. */
export function merchantInsights(amounts: readonly number[], dates: readonly string[]): MerchantKpis["insights"] {
  if (amounts.length < 3) return null;
  const sorted = [...amounts].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const threshold = q3 + 1.5 * (q3 - q1);
  // With ≥4 payments a «large» one means something; fewer only shows the range.
  const largeCount = amounts.length >= 4 && threshold > 0 ? amounts.filter((a) => a > threshold).length : 0;
  const rec = detectRecurrence([...dates]);
  return {
    cadence: rec?.cadence ?? null,
    intervalDays: rec?.intervalDays ?? null,
    nextExpected: rec ? addDays(rec.last, rec.intervalDays) : null,
    typicalLow: round2(q1),
    typicalHigh: round2(q3),
    largeCount,
    largeThreshold: round2(threshold),
  };
}
