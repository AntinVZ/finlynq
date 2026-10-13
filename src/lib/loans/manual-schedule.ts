/**
 * The loan schedule CSV: one fixed layout, used for both the downloadable
 * template and the upload (2026-10-12). Pure — no DB, no fetch — so the Loans
 * page parses the file in the browser and shows problems before anything is
 * sent.
 *
 * There is deliberately no column mapping. The template is the format: the
 * user downloads it (already filled with the loan's current schedule), edits
 * it in a spreadsheet, and uploads it back. Only `date`, `payment` and
 * `interest` are read. `principal` and `balance` are in the template for
 * reference and are worked out again on upload, so they cannot disagree with
 * the other three.
 */

import {
  MAX_SCHEDULE_ROWS,
  normalizeManualSchedule,
  type AmortizationRow,
  type ManualScheduleRow,
} from "@/lib/loan-calculator";

/** Column order of the template. The first three are read back; the rest are reference. */
export const SCHEDULE_CSV_COLUMNS = ["date", "payment", "interest", "principal", "balance"] as const;
const REQUIRED_COLUMNS = ["date", "payment", "interest"] as const;

export type ScheduleCsvResult =
  | { ok: true; rows: ManualScheduleRow[] }
  | { ok: false; errors: string[] };

/** Template rows for the current schedule, in `SCHEDULE_CSV_COLUMNS` order. */
export function scheduleTemplateRows(
  schedule: readonly Pick<AmortizationRow, "date" | "payment" | "interest" | "principal" | "balance">[],
): Array<Record<(typeof SCHEDULE_CSV_COLUMNS)[number], string | number>> {
  return schedule.map((r) => ({
    date: r.date,
    payment: r.payment,
    interest: r.interest,
    principal: r.principal,
    balance: r.balance,
  }));
}

/** Split one CSV line, honouring double-quoted fields and "" escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** "1,234.50", "$587.00", " 87 " -> number. NaN when it is not a plain amount. */
function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[\s,$€£¥]/g, "");
  if (cleaned === "" || !/^-?\d*\.?\d+$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

function toYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Payments closer together than this are not a loan schedule (weekly is the shortest). */
const MIN_PAYMENT_GAP_DAYS = 6;

const dayOf = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);

/**
 * Read the date column. The template writes YYYY-MM-DD, but a spreadsheet
 * re-saves dates in the computer's own style: 9/7/2026 is 7 September on one
 * machine and 9 July on another, and one cell cannot say which. So the WHOLE
 * column is read one way, and the reading has to make sense as a schedule:
 *
 *   - real dates, strictly rising, AND
 *   - at least `MIN_PAYMENT_GAP_DAYS` apart. A monthly schedule on the 7th,
 *     read the wrong way round, becomes consecutive days in one month; that
 *     gap is what gives the wrong reading away.
 *
 * When both readings pass (or a single row could be either), the file is
 * refused rather than guessed: a schedule with the wrong dates is worse than
 * an upload that asks for YYYY-MM-DD.
 */
function parseDateColumn(cells: string[]): { dates: string[] } | { error: string } {
  const unreadable = {
    error:
      "The date column could not be read. Use YYYY-MM-DD (for example 2026-09-07), one payment per line, earliest first.",
  };
  if (cells.every((c) => ISO_RE.test(c))) {
    const iso = cells.map((c) => {
      const m = ISO_RE.exec(c)!;
      return toYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    });
    return iso.every((d): d is string => d != null) ? { dates: iso } : unreadable;
  }

  const readings: string[][] = [];
  for (const monthFirst of [true, false]) {
    const dates = cells.map((c) => {
      const m = SLASH_RE.exec(c);
      if (!m) return null;
      const a = Number(m[1]);
      const b = Number(m[2]);
      return monthFirst ? toYmd(Number(m[3]), a, b) : toYmd(Number(m[3]), b, a);
    });
    if (!dates.every((d): d is string => d != null)) continue;
    const apart = dates.every(
      (d, i) => i === 0 || dayOf(d) - dayOf(dates[i - 1]) >= MIN_PAYMENT_GAP_DAYS,
    );
    if (apart) readings.push(dates);
  }
  if (readings.length === 0) return unreadable;
  if (readings.length === 2 && readings[0].join() !== readings[1].join()) {
    return {
      error:
        "The dates could be read day-first or month-first. Write them as YYYY-MM-DD (for example 2026-09-07) so there is no doubt.",
    };
  }
  return { dates: readings[0] };
}

/**
 * Parse an uploaded schedule file. Returns every problem found (with its line
 * number), not just the first, so the user fixes the file once.
 */
export function parseScheduleCsv(text: string): ScheduleCsvResult {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r\n|\n|\r/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter((l) => l.line.trim() !== "");
  if (!lines.length) return { ok: false, errors: ["The file is empty."] };

  const header = splitCsvLine(lines[0].line).map((h) => h.toLowerCase());
  const col = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    (typeof REQUIRED_COLUMNS)[number],
    number
  >;
  const missing = REQUIRED_COLUMNS.filter((c) => col[c] < 0);
  if (missing.length) {
    return {
      ok: false,
      errors: [
        `The first line must name the columns date, payment and interest (missing: ${missing.join(", ")}). Download the template and keep its first line.`,
      ],
    };
  }

  const body = lines.slice(1);
  if (!body.length) return { ok: false, errors: ["The file has a header but no rows."] };
  if (body.length > MAX_SCHEDULE_ROWS) {
    return { ok: false, errors: [`A schedule can have at most ${MAX_SCHEDULE_ROWS} rows.`] };
  }

  const cells = body.map((l) => ({ n: l.n, f: splitCsvLine(l.line) }));
  const errors: string[] = [];
  const dateColumn = parseDateColumn(cells.map((c) => c.f[col.date] ?? ""));
  const dates = "dates" in dateColumn ? dateColumn.dates : null;
  if ("error" in dateColumn) errors.push(dateColumn.error);
  const rows: ManualScheduleRow[] = [];
  cells.forEach((c, i) => {
    const payment = parseAmount(c.f[col.payment] ?? "");
    const interest = parseAmount(c.f[col.interest] ?? "");
    if (!Number.isFinite(payment) || payment < 0) errors.push(`Line ${c.n}: payment must be a number, 0 or more.`);
    if (!Number.isFinite(interest) || interest < 0) errors.push(`Line ${c.n}: interest must be a number, 0 or more.`);
    if (dates) rows.push({ date: dates[i], payment, interest });
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };

  try {
    return { ok: true, rows: normalizeManualSchedule(rows) };
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : "The schedule is not valid."] };
  }
}
