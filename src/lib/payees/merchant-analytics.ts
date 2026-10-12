/**
 * Merchant analyses (Payee Studio P5d) — eight read-only views per
 * COUNTERPARTY (the directory entry a payee resolves to, else its payee
 * group), complementing ./insights.ts:
 *
 *   1. receipt     average / median / max payment, quartiles, a histogram
 *   2. receiptTrend average payment per month; trend % between the first
 *                  and the last third of the payments (chronological)
 *   3. change      spend change between two periods split into a COUNT
 *                  effect (n2 − n1)·avg1 and a RECEIPT effect n2·(avg2 − avg1);
 *                  the two add up to the total change
 *   4. lifecycle   new (first payment in the last 2 months), quiet (payments
 *                  in ≥ 3 of the 6 months before the last 2, none in the last
 *                  2), returned (paid in the last 2 months after ≥ 3 silent
 *                  months), churned (≥ 3 active months ever, silent ≥ 6 months)
 *   5. regular     ≥ 3 payments, median interval, interval CV < 0.35; yearly
 *                  cost = average payment · 365 / interval; next expected date
 *   6. multiCategory ≥ 2 categories each on ≥ 10 % of the rows — a rule hint
 *   7. businessPersonal both business and personal rows: shares
 *   8. people      private persons / sole proprietors: paid vs received
 *                  (separate sums by sign) and a breakdown by purpose
 *                  (payee remainder after the entry's name → tag → note)
 *
 * Payments are outflows (amount < 0), measured as positive numbers. Money is
 * in the user's display (reporting) currency: a row's stored reporting amount
 * when it is in that currency, otherwise its account amount converted with
 * the current rate map — currencies are never added unconverted.
 *
 * `transactions` is read in id-ordered batches (keyset, MERCHANT_SCAN_BATCH
 * rows per query), decrypted and folded per counterparty; past
 * MERCHANT_SCAN_MAX rows the scan stops and says `truncated`. Read only.
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { convertWithRateMap } from "@/lib/fx-service";
import { parseTags } from "@/lib/tags";
import { guessPayeeType, payeeMatchKey, type PayeeType } from "./match-key";
import { payeeRemainder } from "./lookalikes";
import { decodeStoredPayee, spellingOf, type PayeeExecutor } from "./scan";
import type { PayeeMatcher } from "./directory";
import { bankOperationOf, type PayeeVocabulary } from "./type-words";
import type { OwnMatcher } from "./own-accounts";

export const MERCHANT_SCAN_BATCH = 5_000;
export const MERCHANT_SCAN_MAX = 200_000;

type Row = { date: string; amount: number; categoryId: number | null; accountId: number | null; business: boolean; purpose: string | null };

type Acc = {
  id: string;
  name: string;
  entityId: number | null;
  type: PayeeType;
  isPerson: boolean;
  names: string[];
  rows: Row[];
  /** Unresolved groups: rows per spelling (the most used one names the group). */
  spellings: Map<string, number>;
};

export type Period = { from: string; to: string };

export type MerchantAnalytics = {
  asOf: string;
  currency: string;
  period: Period | null;
  scanned: number;
  truncated: boolean;
  counterparties: number;
  receipt: Array<{ id: string; name: string; entityId: number | null; payments: number; average: number; median: number; max: number; quartiles: [number, number, number]; histogram: Array<{ from: number; to: number; count: number }> }>;
  receiptTrend: Array<{ id: string; name: string; entityId: number | null; months: Array<{ month: string; average: number; payments: number }>; trendPct: number | null }>;
  change: {
    period1: Period;
    period2: Period;
    rows: Array<{ id: string; name: string; entityId: number | null; n1: number; n2: number; avg1: number; avg2: number; spend1: number; spend2: number; countEffect: number; receiptEffect: number; total: number }>;
    totals: { spend1: number; spend2: number; countEffect: number; receiptEffect: number; total: number };
  };
  lifecycle: {
    new: Array<{ id: string; name: string; entityId: number | null; firstDate: string }>;
    quiet: Array<{ id: string; name: string; entityId: number | null; lastDate: string; activeMonths: number }>;
    returned: Array<{ id: string; name: string; entityId: number | null; lastDate: string; silentMonths: number }>;
    churned: Array<{ id: string; name: string; entityId: number | null; lastDate: string }>;
  };
  regular: Array<{ id: string; name: string; entityId: number | null; payments: number; intervalDays: number; cv: number; average: number; yearlyCost: number; lastDate: string; nextExpected: string }>;
  multiCategory: Array<{ id: string; name: string; entityId: number | null; categories: Array<{ categoryId: number | null; name: string; rows: number; share: number }>; hint: string }>;
  businessPersonal: Array<{ id: string; name: string; entityId: number | null; business: number; personal: number; businessShare: number }>;
  people: Array<{ id: string; name: string; entityId: number | null; type: PayeeType; paid: number; received: number; net: number; byPurpose: Array<{ purpose: string; paid: number; received: number; rows: number }> }>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Linear-interpolated quantile of sorted values. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Equal-width histogram over [0, max] (max rounded up to a "nice" number). */
export function histogram(values: number[], bins = 8): Array<{ from: number; to: number; count: number }> {
  if (!values.length) return [];
  const max = Math.max(...values);
  const mag = 10 ** Math.floor(Math.log10(Math.max(max, 1)));
  const top = Math.ceil(max / mag) * mag || 1;
  const width = top / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ from: round2(i * width), to: round2((i + 1) * width), count: 0 }));
  for (const v of values) out[Math.min(bins - 1, Math.floor(v / width))].count++;
  return out;
}

/** Count / receipt decomposition of a spend change. countEffect + receiptEffect === spend2 − spend1. */
export function decomposeChange(n1: number, spend1: number, n2: number, spend2: number) {
  const avg1 = n1 ? spend1 / n1 : 0;
  const avg2 = n2 ? spend2 / n2 : 0;
  const countEffect = (n2 - n1) * avg1;
  const receiptEffect = n2 * (avg2 - avg1);
  return { avg1, avg2, countEffect, receiptEffect, total: spend2 - spend1 };
}

/** Regular payments: ≥ 3 dates, median interval ≥ 5 days, interval CV < 0.35. */
export function regularity(dates: string[]): { intervalDays: number; cv: number } | null {
  const days = [...new Set(dates)].sort();
  if (days.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push((toDay(days[i]) - toDay(days[i - 1])) / DAY);
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = quantile(sorted, 0.5);
  if (med < 5) return null;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  const cv = mean > 0 ? sd / mean : Infinity;
  if (!(cv < 0.35)) return null;
  return { intervalDays: Math.round(med), cv: round2(cv) };
}

function monthAdd(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function inPeriod(date: string, p: Period | null): boolean {
  return !p || (date >= p.from && date <= p.to);
}

export async function computeMerchantAnalytics(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  matcher: PayeeMatcher;
  currency: string;
  rateMap: Map<string, number>;
  /** Limits analyses 1, 2, 5, 6, 7, 8 to this date range (default: all time). */
  period?: Period | null;
  /** Analysis 3: compare these two periods (default: the last 3 months vs the 3 before). */
  period1?: Period;
  period2?: Period;
  /** Only this counterparty: a directory entity id… */
  entityId?: number;
  /** …or any spelling / name (resolved through the directory, else by matching key). */
  name?: string;
  asOf?: string;
  limit?: number;
  categoryNames?: Map<number, string>;
  /** P6 (B25): bank-operation patterns; those rows are not merchants and stay out of every ranking. */
  vocab?: PayeeVocabulary;
  /** P6.2: own accounts / cards — transfers to them are not merchants. */
  own?: OwnMatcher;
  batchSize?: number;
  maxRows?: number;
}): Promise<MerchantAnalytics> {
  const { executor, userId, dek, matcher } = opts;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const batch = Math.max(1, opts.batchSize ?? MERCHANT_SCAN_BATCH);
  const maxRows = opts.maxRows ?? MERCHANT_SCAN_MAX;
  const period = opts.period ?? null;
  const display = opts.currency.toUpperCase();

  // Which counterparty ids to keep (null = all).
  let only: string | null = null;
  if (opts.entityId != null) only = `e:${opts.entityId}`;
  else if (opts.name?.trim()) {
    const m = matcher.match(spellingOf(opts.name));
    only = m.kind === "match" ? `e:${m.entityId}` : `k:${payeeMatchKey(opts.name)}`;
  }

  const accs = new Map<string, Acc>();
  const resolve = new Map<string, { id: string; name: string; entityId: number | null; type: PayeeType; isPerson: boolean; names: string[] } | null>();
  let scanned = 0;
  let truncated = false;
  let after = 0;
  for (;;) {
    const size = Math.min(batch, maxRows - scanned);
    if (size <= 0) {
      truncated = normalizeDbRows(await executor.execute(sql`SELECT 1 FROM transactions WHERE user_id = ${userId} AND id > ${after} LIMIT 1`)).length > 0;
      break;
    }
    const page = normalizeDbRows<Record<string, unknown>>(
      await executor.execute(sql`
        SELECT id, date, amount, currency, reporting_amount, reporting_currency, account_id, category_id, is_business, payee, tags, note
        FROM transactions WHERE user_id = ${userId} AND id > ${after} ORDER BY id LIMIT ${size}`),
    );
    scanned += page.length;
    for (const r of page) {
      after = Number(r.id);
      const plain = decodeStoredPayee(r.payee, null, dek);
      if (plain === undefined) continue;
      const spelling = spellingOf(plain);
      if (!spelling) continue;
      let who = resolve.get(spelling);
      if (who === undefined) {
        const key = payeeMatchKey(spelling);
        const m = matcher.match(spelling);
        if (!key) who = null;
        else if (m.kind !== "match" && !only && bankOperationOf(spelling, opts.vocab)) who = null;
        else if (!only && opts.own && (opts.own.inText(spelling) || (m.kind === "match" && matcher.entity(m.entityId) && opts.own.forEntity(matcher.entity(m.entityId)!)))) who = null;
        else if (m.kind === "match") {
          const e = matcher.entity(m.entityId);
          const type = e?.type ?? "other";
          who = {
            id: `e:${m.entityId}`,
            name: m.name,
            entityId: m.entityId,
            type,
            isPerson: type === "person" || type === "sole_proprietor",
            names: e ? [e.name, ...e.aliases.filter((a) => a.mode === "exact").map((a) => a.pattern)] : [m.name],
          };
        } else {
          const t = guessPayeeType(spelling);
          who = { id: `k:${key}`, name: spelling, entityId: null, type: t.type, isPerson: t.isPerson, names: [spelling] };
        }
        if (resolve.size < 100_000) resolve.set(spelling, who);
      }
      if (!who || (only && who.id !== only)) continue;
      let acc = accs.get(who.id);
      if (!acc) accs.set(who.id, (acc = { ...who, rows: [], spellings: new Map() }));
      if (acc.entityId == null) acc.spellings.set(spelling, (acc.spellings.get(spelling) ?? 0) + 1);
      const date = String(r.date ?? "").slice(0, 10);
      const repCur = r.reporting_currency == null ? null : String(r.reporting_currency).toUpperCase();
      const amount =
        repCur === display && r.reporting_amount != null
          ? Number(r.reporting_amount)
          : convertWithRateMap(Number(r.amount ?? 0) || 0, r.currency == null ? display : String(r.currency), opts.rateMap);
      let purpose: string | null = null;
      if (who.isPerson) {
        purpose = payeeRemainder(spelling, who.names);
        if (!purpose) {
          const tags = parseTags(decodeStoredPayee(r.tags, null, dek) ?? "");
          purpose = tags[0] ?? null;
        }
        if (!purpose) {
          const note = (decodeStoredPayee(r.note, null, dek) ?? "").replace(/\s+/g, " ").trim();
          purpose = note ? note.slice(0, 40) : null;
        }
      }
      acc.rows.push({
        date,
        amount: round2(amount),
        categoryId: r.category_id == null ? null : Number(r.category_id),
        accountId: r.account_id == null ? null : Number(r.account_id),
        business: r.is_business === true || r.is_business === 1 || r.is_business === "1" || r.is_business === "t",
        purpose,
      });
    }
    if (page.length < size) break;
  }

  const list = [...accs.values()];
  for (const a of list) {
    if (a.entityId == null && a.spellings.size) a.name = [...a.spellings.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
  }
  const base = (a: Acc) => ({ id: a.id, name: a.name, entityId: a.entityId });
  const payments = (a: Acc, p: Period | null) => a.rows.filter((r) => r.amount < 0 && inPeriod(r.date, p)).map((r) => ({ ...r, value: -r.amount }));

  // 1. receipt
  const receipt = list
    .map((a) => {
      const vals = payments(a, period).map((r) => r.value).sort((x, y) => x - y);
      if (!vals.length) return null;
      return {
        ...base(a),
        payments: vals.length,
        average: round2(vals.reduce((n, v) => n + v, 0) / vals.length),
        median: round2(quantile(vals, 0.5)),
        max: round2(vals[vals.length - 1]),
        quartiles: [round2(quantile(vals, 0.25)), round2(quantile(vals, 0.5)), round2(quantile(vals, 0.75))] as [number, number, number],
        histogram: histogram(vals),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((x, y) => y.payments * y.average - x.payments * x.average);

  // 2. receipt trend
  const receiptTrend = list
    .map((a) => {
      const ps = payments(a, period).sort((x, y) => x.date.localeCompare(y.date));
      if (ps.length < 3) return null;
      const byMonth = new Map<string, { sum: number; n: number }>();
      for (const p of ps) {
        const m = p.date.slice(0, 7);
        const cur = byMonth.get(m) ?? { sum: 0, n: 0 };
        cur.sum += p.value;
        cur.n++;
        byMonth.set(m, cur);
      }
      const third = Math.max(1, Math.floor(ps.length / 3));
      const avg = (xs: typeof ps) => xs.reduce((n, x) => n + x.value, 0) / xs.length;
      const first = avg(ps.slice(0, third));
      const last = avg(ps.slice(ps.length - third));
      return {
        ...base(a),
        months: [...byMonth.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([month, v]) => ({ month, average: round2(v.sum / v.n), payments: v.n })),
        trendPct: first > 0 ? round2(((last - first) / first) * 100) : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((x, y) => Math.abs(y.trendPct ?? 0) - Math.abs(x.trendPct ?? 0));

  // 3. change between two periods
  const curMonth = asOf.slice(0, 7);
  const period2: Period = opts.period2 ?? { from: `${monthAdd(curMonth, -2)}-01`, to: asOf };
  const period1: Period = opts.period1 ?? { from: `${monthAdd(curMonth, -5)}-01`, to: isoDay(toDay(`${monthAdd(curMonth, -2)}-01`) - DAY) };
  const changeRows = list
    .map((a) => {
      const p1 = payments(a, period1);
      const p2 = payments(a, period2);
      if (!p1.length && !p2.length) return null;
      const spend1 = p1.reduce((n, p) => n + p.value, 0);
      const spend2 = p2.reduce((n, p) => n + p.value, 0);
      const d = decomposeChange(p1.length, spend1, p2.length, spend2);
      return {
        ...base(a),
        n1: p1.length,
        n2: p2.length,
        avg1: round2(d.avg1),
        avg2: round2(d.avg2),
        spend1: round2(spend1),
        spend2: round2(spend2),
        countEffect: round2(d.countEffect),
        receiptEffect: round2(d.receiptEffect),
        total: round2(d.total),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((x, y) => Math.abs(y.total) - Math.abs(x.total));
  const sum = (k: "spend1" | "spend2" | "countEffect" | "receiptEffect" | "total") => round2(changeRows.reduce((n, r) => n + r[k], 0));

  // 4. lifecycle (months of payments, all time, relative to asOf)
  const last2 = new Set([curMonth, monthAdd(curMonth, -1)]);
  const prior6 = new Set(Array.from({ length: 6 }, (_, i) => monthAdd(curMonth, -2 - i)));
  const lifecycle: MerchantAnalytics["lifecycle"] = { new: [], quiet: [], returned: [], churned: [] };
  for (const a of list) {
    const ps = payments(a, null);
    if (!ps.length) continue;
    const months = new Set(ps.map((p) => p.date.slice(0, 7)));
    const sortedDates = ps.map((p) => p.date).sort();
    const firstDate = sortedDates[0];
    const lastDate = sortedDates[sortedDates.length - 1];
    const inLast2 = [...months].some((m) => last2.has(m));
    const activePrior = [...months].filter((m) => prior6.has(m)).length;
    if (inLast2 && last2.has(firstDate.slice(0, 7))) {
      lifecycle.new.push({ ...base(a), firstDate });
      continue;
    }
    if (!inLast2 && activePrior >= 3) {
      lifecycle.quiet.push({ ...base(a), lastDate, activeMonths: activePrior });
      continue;
    }
    if (inLast2) {
      // Silent months right before the last two.
      let silent = 0;
      for (let i = 2; i < 120 && !months.has(monthAdd(curMonth, -i)); i++) silent++;
      if (silent >= 3 && [...months].some((m) => m < monthAdd(curMonth, -1 - silent))) lifecycle.returned.push({ ...base(a), lastDate, silentMonths: silent });
      continue;
    }
    if (months.size >= 3 && lastDate.slice(0, 7) <= monthAdd(curMonth, -6)) lifecycle.churned.push({ ...base(a), lastDate });
  }
  lifecycle.new.sort((x, y) => y.firstDate.localeCompare(x.firstDate));
  lifecycle.quiet.sort((x, y) => y.lastDate.localeCompare(x.lastDate));
  lifecycle.returned.sort((x, y) => y.lastDate.localeCompare(x.lastDate));
  lifecycle.churned.sort((x, y) => y.lastDate.localeCompare(x.lastDate));

  // 5. regular payments
  const regular = list
    .map((a) => {
      const ps = payments(a, period);
      const reg = regularity(ps.map((p) => p.date));
      if (!reg) return null;
      const average = ps.reduce((n, p) => n + p.value, 0) / ps.length;
      const lastDate = ps.map((p) => p.date).sort().at(-1)!;
      return {
        ...base(a),
        payments: ps.length,
        intervalDays: reg.intervalDays,
        cv: reg.cv,
        average: round2(average),
        yearlyCost: round2((average * 365) / reg.intervalDays),
        lastDate,
        nextExpected: isoDay(toDay(lastDate) + reg.intervalDays * DAY),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((x, y) => y.yearlyCost - x.yearlyCost);

  // 6. several categories
  const multiCategory = list
    .map((a) => {
      const rows = a.rows.filter((r) => inPeriod(r.date, period));
      if (rows.length < 2) return null;
      const counts = new Map<number | null, number>();
      for (const r of rows) counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
      const big = [...counts.entries()].filter(([, n]) => n / rows.length >= 0.1).sort((x, y) => y[1] - x[1]);
      if (big.length < 2) return null;
      const cats = big.map(([categoryId, n]) => ({
        categoryId,
        name: categoryId == null ? "Uncategorized" : opts.categoryNames?.get(categoryId) ?? `#${categoryId}`,
        rows: n,
        share: round2(n / rows.length),
      }));
      return {
        ...base(a),
        categories: cats,
        hint: `Split across ${cats.length} categories: if it is always the same kind of purchase, a rule “payee is ${a.name} → ${cats[0].name}” would keep it consistent.`,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((x, y) => y.categories.length - x.categories.length || y.categories[1].share - x.categories[1].share);

  // 7. business and personal
  const businessPersonal = list
    .map((a) => {
      const rows = a.rows.filter((r) => inPeriod(r.date, period));
      const business = rows.filter((r) => r.business).length;
      const personal = rows.length - business;
      if (!business || !personal) return null;
      return { ...base(a), business, personal, businessShare: round2(business / rows.length) };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((x, y) => Math.min(y.business, y.personal) - Math.min(x.business, x.personal));

  // 8. people: paid vs received, by purpose
  const people = list
    .filter((a) => a.isPerson)
    .map((a) => {
      const rows = a.rows.filter((r) => inPeriod(r.date, period));
      if (!rows.length) return null;
      const paid = rows.filter((r) => r.amount < 0).reduce((n, r) => n - r.amount, 0);
      const received = rows.filter((r) => r.amount > 0).reduce((n, r) => n + r.amount, 0);
      const byPurpose = new Map<string, { purpose: string; paid: number; received: number; rows: number }>();
      for (const r of rows) {
        const k = r.purpose ?? "(no purpose)";
        const cur = byPurpose.get(k) ?? { purpose: k, paid: 0, received: 0, rows: 0 };
        if (r.amount < 0) cur.paid += -r.amount;
        else cur.received += r.amount;
        cur.rows++;
        byPurpose.set(k, cur);
      }
      return {
        ...base(a),
        type: a.type,
        paid: round2(paid),
        received: round2(received),
        net: round2(received - paid),
        byPurpose: [...byPurpose.values()].map((p) => ({ ...p, paid: round2(p.paid), received: round2(p.received) })).sort((x, y) => y.paid + y.received - (x.paid + x.received)),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((x, y) => y.paid + y.received - (x.paid + x.received));

  const cap = <T,>(xs: T[]) => (only ? xs : xs.slice(0, limit));
  return {
    asOf,
    currency: display,
    period,
    scanned,
    truncated,
    counterparties: list.length,
    receipt: cap(receipt),
    receiptTrend: cap(receiptTrend),
    change: { period1, period2, rows: cap(changeRows), totals: { spend1: sum("spend1"), spend2: sum("spend2"), countEffect: sum("countEffect"), receiptEffect: sum("receiptEffect"), total: sum("total") } },
    lifecycle: { new: cap(lifecycle.new), quiet: cap(lifecycle.quiet), returned: cap(lifecycle.returned), churned: cap(lifecycle.churned) },
    regular: cap(regular),
    multiCategory: cap(multiCategory),
    businessPersonal: cap(businessPersonal),
    people: cap(people),
  };
}
