/**
 * Numbers, money and dates for the interface language (P8 stage 6), all via
 * `Intl`. `compact` money gives "38 тис. ₴" / "UAH 38K". Pure.
 */
import { intlLocaleOf } from "./registry";

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  let f = cache.get(key) as T | undefined;
  if (!f) cache.set(key, (f = make()));
  return f;
}

export function formatNumber(locale: string, n: number, opts: Intl.NumberFormatOptions = {}): string {
  const l = intlLocaleOf(locale);
  return cached(`n|${l}|${JSON.stringify(opts)}`, () => new Intl.NumberFormat(l, opts)).format(n);
}

export function formatMoney(locale: string, amount: number, currency: string, opts: { compact?: boolean } = {}): string {
  const l = intlLocaleOf(locale);
  const key = `m|${l}|${currency}|${opts.compact ? 1 : 0}`;
  try {
    return cached(key, () =>
      new Intl.NumberFormat(l, {
        style: "currency",
        currency,
        ...(opts.compact ? { notation: "compact", maximumFractionDigits: 1 } : {}),
      }),
    ).format(amount);
  } catch {
    // Not an ISO currency (a crypto ticker…): the number and the code.
    return `${formatNumber(locale, amount, opts.compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 })} ${currency}`;
  }
}

/** A `YYYY-MM-DD` (or ISO timestamp) date; `month` = `YYYY-MM` → "жовт. 2026". */
export function formatDate(locale: string, value: string | Date | null | undefined, style: "short" | "medium" | "month" = "medium"): string {
  if (value == null || value === "") return "—";
  const s = typeof value === "string" ? value : value.toISOString();
  const d = new Date(/^\d{4}-\d{2}$/.test(s) ? `${s}-01T00:00:00Z` : /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) return s;
  const l = intlLocaleOf(locale);
  const opts: Intl.DateTimeFormatOptions =
    style === "month" ? { year: "numeric", month: "short", timeZone: "UTC" } : style === "short" ? { dateStyle: "short", timeZone: "UTC" } : { dateStyle: "medium", timeZone: "UTC" };
  return cached(`d|${l}|${style}`, () => new Intl.DateTimeFormat(l, opts)).format(d);
}
