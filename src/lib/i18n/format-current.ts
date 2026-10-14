/**
 * Formatting in the CURRENT interface language (P8 stage 6) for plain
 * helpers and components that render with `useT()` (they re-render when the
 * language changes). English keeps the app's own en-CA formatting
 * (@/lib/currency) so English screens look as before; other languages go
 * through Intl (`38 400,00 ₴`, `13 жовт. 2026 р.`).
 */
import { formatCurrency as formatCurrencyEn } from "@/lib/currency";
import { currentLocale } from "./current";
import { formatDate as formatDateIn, formatMoney, formatNumber as formatNumberIn } from "./format";
import { intlLocaleOf } from "./registry";

const english = () => intlLocaleOf(currentLocale()) === "en";

export function formatCurrency(amount: number, currency: string = "USD", opts?: { decimals?: number; compact?: boolean }): string {
  if (opts?.compact) return formatMoney(currentLocale(), amount, currency, { compact: true });
  return english() ? formatCurrencyEn(amount, currency, opts) : formatMoney(currentLocale(), amount, currency);
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return formatNumberIn(currentLocale(), n, opts);
}

/** `YYYY-MM-DD` / `YYYY-MM` in the interface language; English keeps the ISO date. */
export function formatDate(value: string | null | undefined, style: "short" | "medium" | "month" = "medium"): string {
  if (value == null || value === "") return "—";
  return english() ? value : formatDateIn(currentLocale(), value, style);
}
