/**
 * Payee insights (Payee Studio P4): who the money goes to and how that
 * changes, per COUNTERPARTY — a directory entity when the payee resolves to
 * one, otherwise the payee group (one matching key).
 *
 *   - top:          by spend (net outflow) and by number of transactions, in a
 *                   window of the last `months` months (default 12)
 *   - monthly:      per month totals for the top counterparties + all others
 *   - new:          first seen within the last `recentDays` (default 90)
 *   - gone:         recurring counterparties not seen for 2× their usual
 *                   interval (and at least `recentDays`)
 *   - recurring:    ≥ 3 transactions on distinct dates whose intervals are
 *                   regular (coefficient of variation ≤ 0.35): typical
 *                   interval, cadence label, next expected date
 *   - concentration: share of spend of the top 5 / top 10 and the HHI
 *
 * P6.2 (76): transfers between the user's own accounts (a payee that
 * mentions an own IBAN / card, or resolves to an entry holding one) are not
 * merchants either: counted in `totals.ownTransfers`, out of the tops,
 * the monthly split and concentration — like the bank's own rows.
 *
 * Money is the signed sum of `transactions` in the display currency
 * (`convert`); "spend" is the net outflow (−total when negative). Read only;
 * only `transactions` is scanned (other tables mirror it).
 */
import { mergeSlices, scanPayees, type AmountSlice, type PayeeExecutor } from "./scan";
import type { PayeeMatcher } from "./directory";
import { bankOperationOf, type PayeeVocabulary } from "./type-words";
import { EMPTY_OWN_MATCHER, type OwnMatcher } from "./own-accounts";
import { formatMerchantType, merchantTypeFilter, type MerchantTypeRef } from "./merchant-types";
import { st } from "@/lib/i18n/current";

export type Counterparty = {
  /** `e:<entityId>` or `k:<matching key>`. */
  id: string;
  name: string;
  entityId: number | null;
  count: number;
  total: number;
  spend: number;
  firstDate: string | null;
  lastDate: string | null;
};

export type RecurringInfo = Counterparty & {
  intervalDays: number;
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "irregular-regular";
  nextExpected: string;
  /** Average amount per transaction in the display currency. */
  typicalAmount: number;
};

export type PayeeInsights = {
  asOf: string;
  window: { months: number; from: string };
  currency: string;
  /** `bankOperations`: the bank's own service rows (P6, B25) — counted here, kept out of the tops and concentration. */
  totals: { counterparties: number; transactions: number; spend: number; income: number; bankOperations: { transactions: number; spend: number }; ownTransfers: { transactions: number; spend: number } };
  topBySpend: Counterparty[];
  topByCount: Counterparty[];
  monthly: { months: string[]; series: Array<{ id: string; name: string; values: number[] }> };
  newCounterparties: Counterparty[];
  goneCounterparties: Array<Counterparty & { expectedEveryDays: number; daysSilent: number }>;
  recurring: RecurringInfo[];
  concentration: { top5Share: number; top10Share: number; hhi: number; label: "low" | "moderate" | "high" };
  /** P6 (B26): spend per merchant type (group or position) in the window, when asked for. */
  byMerchantType?: Array<{ type: string; spend: number; transactions: number; counterparties: number }>;
  /** P6: the merchant-type filter applied to every list, when given. */
  merchantType?: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Months YYYY-MM from `from` to `to` inclusive. */
function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Regular-interval detection over transaction dates. Null when not regular. */
export function detectRecurrence(dates: string[]): { intervalDays: number; cadence: RecurringInfo["cadence"]; last: string } | null {
  const days = [...new Set(dates)].sort();
  if (days.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push((toDay(days[i]) - toDay(days[i - 1])) / DAY);
  const med = median(gaps);
  if (med < 5) return null; // several times a week is habit, not a schedule
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  if (mean <= 0 || sd / mean > 0.35) return null;
  const cadence: RecurringInfo["cadence"] =
    med <= 9 ? "weekly" : med <= 17 ? "biweekly" : med <= 35 ? "monthly" : med <= 100 ? "quarterly" : med >= 330 && med <= 400 ? "yearly" : "irregular-regular";
  return { intervalDays: Math.round(med), cadence, last: days[days.length - 1] };
}

export async function computePayeeInsights(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  matcher: PayeeMatcher;
  convert: (slices: AmountSlice[]) => number;
  currency: string;
  months?: number;
  recentDays?: number;
  asOf?: string;
  limit?: number;
  /** P6: type words / bank-operation patterns (default: built-in). */
  vocab?: PayeeVocabulary;
  /** P6 (B26): a directory entry's merchant type. */
  merchantTypeOf?: (entityId: number) => MerchantTypeRef | null;
  /** P6: only counterparties of this type (group, position, "Group → Position", "без типу"). */
  merchantType?: string;
  /** P6: add `byMerchantType`, grouped by the type's group or position. */
  groupByMerchantType?: "group" | "position";
  /** P6.2: own accounts / cards — transfers to them are not merchant spend. */
  own?: OwnMatcher;
}): Promise<PayeeInsights> {
  const own = opts.own ?? EMPTY_OWN_MATCHER;
  const months = Math.min(Math.max(opts.months ?? 12, 1), 60);
  const recentDays = Math.min(Math.max(opts.recentDays ?? 90, 7), 730);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const asOfMs = toDay(asOf);
  const fromMonth = (() => {
    const d = new Date(asOfMs);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - (months - 1));
    return d.toISOString().slice(0, 7);
  })();
  const windowMonths = monthRange(fromMonth, asOf.slice(0, 7));

  const scan = await scanPayees({ executor: opts.executor, userId: opts.userId, dek: opts.dek, sources: ["transactions"], withMonths: true, withDates: true });

  type Acc = {
    id: string;
    name: string;
    entityId: number | null;
    spellingCounts: Map<string, number>;
    count: number;
    slices: Map<string, AmountSlice>;
    months: Map<string, Map<string, AmountSlice>>;
    monthCounts: Map<string, number>;
    dates: string[];
    firstDate: string | null;
    lastDate: string | null;
    /** The bank's own service row (fee, own transfer, interest…). */
    bankOperation: boolean;
    /** P6.2: a transfer between own accounts. */
    ownTransfer: boolean;
  };
  const accs = new Map<string, Acc>();
  const ownEntity = (id: number | null) => {
    const e = id == null ? undefined : opts.matcher.entity(id);
    return Boolean(e && own.forEntity(e));
  };
  for (const s of scan.spellings.values()) {
    if (!s.key || s.counts.transactions === 0) continue;
    const m = opts.matcher.match(s.spelling);
    const id = m.kind === "match" ? `e:${m.entityId}` : `k:${s.key}`;
    let a = accs.get(id);
    if (!a) {
      a = {
        id,
        name: m.kind === "match" ? m.name : s.spelling,
        entityId: m.kind === "match" ? m.entityId : null,
        spellingCounts: new Map(),
        count: 0,
        slices: new Map(),
        months: new Map(),
        monthCounts: new Map(),
        dates: [],
        firstDate: null,
        lastDate: null,
        bankOperation: false,
        ownTransfer: ownEntity(m.kind === "match" ? m.entityId : null),
      };
      accs.set(id, a);
    }
    if (own.inText(s.spelling)) a.ownTransfer = true;
    else if (bankOperationOf(s.spelling, opts.vocab)) a.bankOperation = true;
    a.spellingCounts.set(s.spelling, s.counts.transactions);
    a.count += s.counts.transactions;
    mergeSlices(a.slices, s.slices);
    for (const [mo, sl] of s.months ?? []) {
      let t = a.months.get(mo);
      if (!t) a.months.set(mo, (t = new Map()));
      mergeSlices(t, sl);
    }
    for (const [mo, n] of s.monthCounts ?? []) a.monthCounts.set(mo, (a.monthCounts.get(mo) ?? 0) + n);
    a.dates.push(...(s.dates ?? []));
    if (s.firstDate && (!a.firstDate || s.firstDate < a.firstDate)) a.firstDate = s.firstDate;
    if (s.lastDate && (!a.lastDate || s.lastDate > a.lastDate)) a.lastDate = s.lastDate;
  }
  // Unresolved groups show their most used spelling.
  for (const a of accs.values()) {
    if (a.entityId == null) a.name = [...a.spellingCounts.entries()].sort((x, y) => y[1] - x[1])[0][0];
  }

  const cps = [...accs.values()].map((a) => {
    let total = 0;
    let count = 0;
    for (const mo of windowMonths) {
      const sl = a.months.get(mo);
      if (sl) total += opts.convert([...sl.values()]);
      count += a.monthCounts.get(mo) ?? 0;
    }
    return {
      acc: a,
      window: { total: round2(total), count, spend: round2(Math.max(0, -total)) },
      lifetime: round2(opts.convert([...a.slices.values()])),
    };
  });
  const asCp = (c: (typeof cps)[number]): Counterparty => ({
    id: c.acc.id,
    name: c.acc.name,
    entityId: c.acc.entityId,
    count: c.window.count,
    total: c.window.total,
    spend: c.window.spend,
    firstDate: c.acc.firstDate,
    lastDate: c.acc.lastDate,
  });
  const typeOf = (c: (typeof cps)[number]) => (c.acc.entityId != null && opts.merchantTypeOf ? opts.merchantTypeOf(c.acc.entityId) : null);
  const typeTest = opts.merchantType?.trim() ? merchantTypeFilter(opts.merchantType) : null;
  const active = cps.filter((c) => c.window.count > 0 && (!typeTest || typeTest(typeOf(c))));
  // B25: merchant tops, the monthly split and concentration leave the bank's own rows out.
  const inWindow = active.filter((c) => !c.acc.bankOperation && !c.acc.ownTransfer);
  const bankOps = active.filter((c) => c.acc.bankOperation && !c.acc.ownTransfer);
  const ownTransfers = active.filter((c) => c.acc.ownTransfer);
  const topBySpend = [...inWindow].filter((c) => c.window.spend > 0).sort((a, b) => b.window.spend - a.window.spend).slice(0, limit);
  const topByCount = [...inWindow].sort((a, b) => b.window.count - a.window.count || b.window.spend - a.window.spend).slice(0, limit);

  // Monthly series: top 5 by spend + "Everyone else".
  const top5 = topBySpend.slice(0, 5);
  const top5Ids = new Set(top5.map((c) => c.acc.id));
  const series = top5.map((c) => ({
    id: c.acc.id,
    name: c.acc.name,
    values: windowMonths.map((mo) => round2(opts.convert([...(c.acc.months.get(mo)?.values() ?? [])]))),
  }));
  series.push({
    id: "other",
    name: st("srv.insights.everyoneElse"),
    values: windowMonths.map((mo) =>
      round2(inWindow.filter((c) => !top5Ids.has(c.acc.id)).reduce((n, c) => n + opts.convert([...(c.acc.months.get(mo)?.values() ?? [])]), 0)),
    ),
  });

  const recentFrom = isoDay(asOfMs - recentDays * DAY);
  const newCounterparties = cps
    .filter((c) => c.acc.firstDate && c.acc.firstDate >= recentFrom)
    .sort((a, b) => (b.acc.firstDate ?? "").localeCompare(a.acc.firstDate ?? ""))
    .slice(0, limit)
    .map(asCp);

  const recurring: RecurringInfo[] = [];
  const gone: PayeeInsights["goneCounterparties"] = [];
  for (const c of cps) {
    const r = detectRecurrence(c.acc.dates);
    if (!r) continue;
    const silent = Math.round((asOfMs - toDay(r.last)) / DAY);
    const info = {
      ...asCp(c),
      intervalDays: r.intervalDays,
      cadence: r.cadence,
      nextExpected: isoDay(toDay(r.last) + r.intervalDays * DAY),
      typicalAmount: round2(c.lifetime / Math.max(1, c.acc.count)),
    };
    if (silent > Math.max(2 * r.intervalDays, recentDays)) gone.push({ ...info, expectedEveryDays: r.intervalDays, daysSilent: silent });
    else recurring.push(info);
  }
  recurring.sort((a, b) => Math.abs(b.typicalAmount) - Math.abs(a.typicalAmount));
  gone.sort((a, b) => a.daysSilent - b.daysSilent);

  const totalSpend = inWindow.reduce((n, c) => n + c.window.spend, 0);
  const totalIncome = inWindow.reduce((n, c) => n + Math.max(0, c.window.total), 0);
  const spends = inWindow.map((c) => c.window.spend).filter((x) => x > 0).sort((a, b) => b - a);
  const share = (k: number) => (totalSpend > 0 ? round2((spends.slice(0, k).reduce((n, x) => n + x, 0) / totalSpend) * 100) / 100 : 0);
  const hhi = totalSpend > 0 ? Math.round(spends.reduce((n, x) => n + (x / totalSpend) ** 2, 0) * 10_000) : 0;

  let byMerchantType: PayeeInsights["byMerchantType"];
  if (opts.groupByMerchantType) {
    const m = new Map<string, { type: string; spend: number; transactions: number; counterparties: number }>();
    for (const c of active) {
      const t = typeOf(c);
      const label = t ? (opts.groupByMerchantType === "group" ? t.group : formatMerchantType(t)) : st("srv.insights.untyped");
      const r = m.get(label) ?? { type: label, spend: 0, transactions: 0, counterparties: 0 };
      r.spend += c.window.spend;
      r.transactions += c.window.count;
      r.counterparties++;
      m.set(label, r);
    }
    byMerchantType = [...m.values()].map((r) => ({ ...r, spend: round2(r.spend) })).sort((a, b) => b.spend - a.spend || a.type.localeCompare(b.type));
  }

  return {
    ...(byMerchantType ? { byMerchantType } : {}),
    ...(opts.merchantType?.trim() ? { merchantType: opts.merchantType.trim() } : {}),
    asOf,
    window: { months, from: `${fromMonth}-01` },
    currency: opts.currency,
    totals: {
      counterparties: inWindow.length,
      transactions: inWindow.reduce((n, c) => n + c.window.count, 0),
      spend: round2(totalSpend),
      income: round2(totalIncome),
      bankOperations: { transactions: bankOps.reduce((n, c) => n + c.window.count, 0), spend: round2(bankOps.reduce((n, c) => n + c.window.spend, 0)) },
      ownTransfers: { transactions: ownTransfers.reduce((n, c) => n + c.window.count, 0), spend: round2(ownTransfers.reduce((n, c) => n + c.window.spend, 0)) },
    },
    topBySpend: topBySpend.map(asCp),
    topByCount: topByCount.map(asCp),
    monthly: { months: windowMonths, series },
    newCounterparties,
    goneCounterparties: gone.slice(0, limit),
    recurring: recurring.slice(0, limit * 2),
    concentration: { top5Share: share(5), top10Share: share(10), hhi, label: hhi >= 2500 ? "high" : hhi >= 1500 ? "moderate" : "low" },
  };
}
