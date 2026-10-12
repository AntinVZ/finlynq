/**
 * Report period granularities — the single list behind the Reports page's
 * Period select and `GET /api/reports/trends?period=`. Pure (no DB), so the
 * client page can import it. `shared/types.ts` `ReportPeriod` mirrors this
 * union for the mobile app; keep the two in sync.
 */
export const REPORT_PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_PERIOD_LABELS: Record<ReportPeriod, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export function isReportPeriod(value: unknown): value is ReportPeriod {
  return typeof value === "string" && (REPORT_PERIODS as readonly string[]).includes(value);
}

/**
 * Range presets wide enough that a monthly breakdown is unreadable (60+
 * columns). Picking one switches the Period select to Yearly.
 */
export const MULTI_YEAR_PRESETS: readonly string[] = ["last-5-years", "all-time"];

/**
 * Start date for the "All Time" preset. `transactions.date` is TEXT
 * `YYYY-MM-DD` compared lexically, so any date earlier than the first
 * transaction works; periods only appear where rows exist.
 */
export const ALL_TIME_START = "1970-01-01";
