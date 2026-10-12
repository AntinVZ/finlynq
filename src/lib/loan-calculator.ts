// Feature 1: Loan & Amortization Calculator
// Feature 12: Debt Payoff Planner
// FINLYNQ-136 (Loans & Debt v2): payment-driven amortization, full frequency
// set, per-calendar-month interest accrual, lease residual values.

export const PAYMENT_FREQUENCIES = [
  "weekly",
  "biweekly",
  "semi_monthly",
  "monthly",
  "quarterly",
  "annual",
] as const;
export type PaymentFrequency = (typeof PAYMENT_FREQUENCIES)[number];

export const PERIODS_PER_YEAR: Record<PaymentFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semi_monthly: 24,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

// Legacy rows may carry arbitrary frequency strings; anything unknown degrades
// to monthly (same fall-through the v1 calculator had).
export function normalizeFrequency(freq?: string | null): PaymentFrequency {
  return (PAYMENT_FREQUENCIES as readonly string[]).includes(freq ?? "")
    ? (freq as PaymentFrequency)
    : "monthly";
}

// Thrown for user-correctable inputs (payment doesn't cover interest, residual
// >= principal). API routes map this to a 400 instead of a 500.
export class LoanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoanValidationError";
  }
}

export type AmortizationRow = {
  period: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  extraPayment: number;
  balance: number;
  // True when this row's interest came from `interestOverrides` rather than
  // the calculation. Absent on calculated rows and on manual schedules.
  interestOverridden?: boolean;
};

// One row of a user-supplied schedule. Principal (payment - interest) and the
// running balance are derived, never stored.
export type ManualScheduleRow = { date: string; payment: number; interest: number };

export const MAX_SCHEDULE_ROWS = 1200;

export type MonthlyAccrualRow = {
  month: string; // "YYYY-MM"
  interest: number;
};

export type LoanSummary = {
  // Per-period payment. Kept under the legacy `monthlyPayment` name because
  // every existing consumer (web UI, MCP HTTP, REST) reads this field; for
  // non-monthly frequencies it is the payment per period, not per month.
  monthlyPayment: number;
  paymentPerPeriod: number;
  // payment * periodsPerYear / 12 — comparable across frequencies.
  monthlyEquivalentPayment: number;
  paymentFrequency: PaymentFrequency;
  periodsPerYear: number;
  totalPayments: number;
  totalInterest: number;
  payoffDate: string;
  // Lease: balance remaining at the end of the schedule (0 for normal loans).
  residualValue: number;
  schedule: AmortizationRow[];
  // Per-calendar-month reportable interest, day-weighted across periods that
  // straddle month boundaries. Sums to totalInterest within rounding.
  monthlyAccrual: MonthlyAccrualRow[];
  // "manual" when the rows came from `manualSchedule`, else "calculated".
  scheduleMode: "calculated" | "manual";
};

export type LoanScheduleOptions = {
  principal: number;
  annualRate: number; // percent, e.g. 5.5
  startDate: string; // YYYY-MM-DD
  // Term-driven mode: payment derived from term. Ignored for payment
  // derivation when paymentAmount is provided (payment-driven mode).
  termMonths?: number | null;
  // Payment-driven mode: the schedule solves for the number of periods.
  paymentAmount?: number | null;
  paymentFrequency?: string | null;
  extraPayment?: number | null; // extra principal per period
  residualValue?: number | null; // lease balloon: amortize down to this
  // Interest the lender actually charged for specific payment dates
  // (YYYY-MM-DD -> amount). Replaces the calculated figure for that row only;
  // the payment is unchanged, so the principal and every later balance follow.
  // Ignored when `manualSchedule` is set.
  interestOverrides?: Record<string, number> | null;
  // A complete user-supplied schedule. When non-empty it REPLACES the
  // calculation: rate, term and payment are not used to build rows.
  manualSchedule?: readonly ManualScheduleRow[] | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function parseYmdUTC(ymd: string): Date {
  return new Date(ymd + "T00:00:00Z");
}

function ymd(date: Date): string {
  return date.toISOString().split("T")[0];
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

// Month arithmetic that clamps to the last day of the target month
// (Jan 31 + 1mo = Feb 28/29, not Mar 3).
function addMonthsClamped(start: Date, months: number): Date {
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(start.getUTCDate(), daysInTarget))
  );
}

function addDays(start: Date, days: number): Date {
  return new Date(start.getTime() + days * 86_400_000);
}

// Payment date for period i (1-based) from the loan start date.
function periodDate(start: Date, i: number, freq: PaymentFrequency): Date {
  switch (freq) {
    case "weekly":
      return addDays(start, 7 * i);
    case "biweekly":
      return addDays(start, 14 * i);
    case "semi_monthly":
      // Periods alternate +15 days / next month anchor: start+15d, +1mo,
      // +1mo15d, +2mo, ... (24 payments/year on the anchor day and ~15 later).
      return i % 2 === 1
        ? addDays(addMonthsClamped(start, (i - 1) / 2), 15)
        : addMonthsClamped(start, i / 2);
    case "monthly":
      return addMonthsClamped(start, i);
    case "quarterly":
      return addMonthsClamped(start, 3 * i);
    case "annual":
      return addMonthsClamped(start, 12 * i);
  }
}

// Day-weighted allocation of one period's interest across the calendar months
// the period spans — the per-month figure is what gets *reported*, regardless
// of payment frequency.
function allocateInterestByMonth(
  prev: Date,
  curr: Date,
  interest: number,
  acc: Map<string, number>
) {
  const add = (key: string, v: number) => acc.set(key, (acc.get(key) ?? 0) + v);
  const spanMs = curr.getTime() - prev.getTime();
  if (spanMs <= 0) {
    add(monthKey(curr), interest);
    return;
  }
  let cursor = prev;
  while (cursor < curr) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const chunkEnd = monthEnd < curr ? monthEnd : curr;
    add(monthKey(cursor), (interest * (chunkEnd.getTime() - cursor.getTime())) / spanMs);
    cursor = chunkEnd;
  }
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealYmd(value: unknown): value is string {
  if (typeof value !== "string" || !YMD_RE.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && ymd(d) === value;
}

/**
 * Validate and normalize a user-supplied schedule. Rows come back sorted by
 * date. Throws LoanValidationError (a 400, never a 500) for anything a user
 * can fix: no rows, too many, a bad or repeated date, a negative amount.
 */
export function normalizeManualSchedule(input: unknown): ManualScheduleRow[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new LoanValidationError("A manual schedule needs at least one row");
  }
  if (input.length > MAX_SCHEDULE_ROWS) {
    throw new LoanValidationError(`A schedule can have at most ${MAX_SCHEDULE_ROWS} rows`);
  }
  const rows = input.map((raw, i): ManualScheduleRow => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const payment = Number(r.payment);
    const interest = Number(r.interest);
    if (!isRealYmd(r.date)) {
      throw new LoanValidationError(`Row ${i + 1}: date must be a real date in YYYY-MM-DD form`);
    }
    if (!Number.isFinite(payment) || payment < 0) {
      throw new LoanValidationError(`Row ${i + 1} (${r.date}): payment must be 0 or more`);
    }
    if (!Number.isFinite(interest) || interest < 0) {
      throw new LoanValidationError(`Row ${i + 1} (${r.date}): interest must be 0 or more`);
    }
    return { date: r.date, payment: round2(payment), interest: round2(interest) };
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].date === rows[i - 1].date) {
      throw new LoanValidationError(`${rows[i].date} appears more than once`);
    }
  }
  return rows;
}

/** Validate a date -> interest override map. Same error contract as above. */
export function normalizeInterestOverrides(input: unknown): Record<string, number> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new LoanValidationError("Interest overrides must be a date to amount map");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_SCHEDULE_ROWS) {
    throw new LoanValidationError(`At most ${MAX_SCHEDULE_ROWS} interest overrides`);
  }
  const out: Record<string, number> = {};
  for (const [date, raw] of entries) {
    const amount = Number(raw);
    if (!isRealYmd(date)) {
      throw new LoanValidationError(`${date} is not a real date in YYYY-MM-DD form`);
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new LoanValidationError(`Interest for ${date} must be 0 or more`);
    }
    out[date] = round2(amount);
  }
  return out;
}

/**
 * The stored schedule customizations of a loan row, ready to spread into
 * `buildLoanSchedule` options. Accepts the Drizzle shape (`manualSchedule`)
 * and the raw-SQL shape (`manual_schedule`), and JSON that arrived as text.
 *
 * EVERY caller that builds a schedule from a stored loan must spread this in.
 * A caller that forgets shows the calculated schedule while the Loans page
 * shows the user's own, and the two then disagree about balances and payoff.
 */
export function loanScheduleExtras(
  row: object,
): Pick<LoanScheduleOptions, "manualSchedule" | "interestOverrides"> {
  const r = row as Record<string, unknown>;
  const parse = (v: unknown): unknown => {
    if (typeof v !== "string") return v ?? null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const manual = parse(r.manualSchedule ?? r.manual_schedule);
  const overrides = parse(r.interestOverrides ?? r.interest_overrides);
  return {
    manualSchedule:
      Array.isArray(manual) && manual.length ? (manual as ManualScheduleRow[]) : null,
    interestOverrides:
      overrides && typeof overrides === "object" && !Array.isArray(overrides)
        ? (overrides as Record<string, number>)
        : null,
  };
}

// The payment that occurs most often (the latest one on a tie). A manual
// schedule can vary row to row; this is the figure shown as "the payment".
function typicalPayment(rows: readonly ManualScheduleRow[]): number {
  const counts = new Map<number, number>();
  let best = rows[rows.length - 1].payment;
  let bestCount = 0;
  for (const r of rows) {
    const n = (counts.get(r.payment) ?? 0) + 1;
    counts.set(r.payment, n);
    if (n >= bestCount) {
      best = r.payment;
      bestCount = n;
    }
  }
  return best;
}

// Build the summary from user-supplied rows. Principal is payment - interest
// (negative when a payment did not cover its interest, so the balance grows),
// capped at the balance left so a final over-payment cannot go below zero.
function buildManualSchedule(opts: LoanScheduleOptions): LoanSummary {
  if (opts.principal <= 0) throw new LoanValidationError("Principal must be greater than 0");
  const rows = normalizeManualSchedule(opts.manualSchedule);
  const freq = normalizeFrequency(opts.paymentFrequency);
  const periodsPerYear = PERIODS_PER_YEAR[freq];
  const schedule: AmortizationRow[] = [];
  const accrual = new Map<string, number>();
  let balance = opts.principal;
  let totalInterest = 0;
  let totalPayments = 0;
  let prevDate = isRealYmd(opts.startDate) ? parseYmdUTC(opts.startDate) : parseYmdUTC(rows[0].date);
  let payoffDate: string | null = null;

  rows.forEach((row, i) => {
    const date = parseYmdUTC(row.date);
    let principalPortion = row.payment - row.interest;
    if (principalPortion > balance) principalPortion = balance;
    balance = Math.max(balance - principalPortion, 0);
    totalInterest += row.interest;
    totalPayments += row.payment;
    allocateInterestByMonth(prevDate, date, row.interest, accrual);
    prevDate = date;
    if (payoffDate == null && balance <= 0.01) payoffDate = row.date;
    schedule.push({
      period: i + 1,
      date: row.date,
      payment: round2(row.payment),
      principal: round2(principalPortion),
      interest: round2(row.interest),
      extraPayment: 0,
      balance: round2(balance),
    });
  });

  const payment = typicalPayment(rows);
  return {
    monthlyPayment: round2(payment),
    paymentPerPeriod: round2(payment),
    monthlyEquivalentPayment: round2((payment * periodsPerYear) / 12),
    paymentFrequency: freq,
    periodsPerYear,
    totalPayments: round2(totalPayments),
    totalInterest: round2(totalInterest),
    payoffDate: payoffDate ?? rows[rows.length - 1].date,
    // What the supplied rows leave unpaid (0 when they run to payoff).
    residualValue: round2(balance),
    schedule,
    monthlyAccrual: Array.from(accrual.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, interest]) => ({ month, interest: round2(interest) })),
    scheduleMode: "manual",
  };
}

export function calculateMonthlyPayment(principal: number, annualRate: number, termMonths: number): number {
  const r = annualRate / 100 / 12;
  if (r === 0) return principal / termMonths;
  return (principal * r * Math.pow(1 + r, termMonths)) / (Math.pow(1 + r, termMonths) - 1);
}

// Per-period payment that amortizes `principal` down to `residual` over `n`
// periods at per-period rate `r` (standard balloon-payment annuity formula).
export function calculatePeriodPayment(
  principal: number,
  r: number,
  n: number,
  residual: number = 0
): number {
  if (n <= 0) return principal - residual;
  if (r === 0) return (principal - residual) / n;
  const pvResidual = residual / Math.pow(1 + r, n);
  return ((principal - pvResidual) * r) / (1 - Math.pow(1 + r, -n));
}

export function buildLoanSchedule(opts: LoanScheduleOptions): LoanSummary {
  if (opts.manualSchedule && opts.manualSchedule.length) return buildManualSchedule(opts);
  const overrides = opts.interestOverrides ?? null;
  const freq = normalizeFrequency(opts.paymentFrequency);
  const periodsPerYear = PERIODS_PER_YEAR[freq];
  const r = opts.annualRate / 100 / periodsPerYear;
  const extra = Math.max(0, opts.extraPayment ?? 0);
  const residual = Math.max(0, opts.residualValue ?? 0);
  const principal = opts.principal;

  if (principal <= 0) throw new LoanValidationError("Principal must be greater than 0");
  if (residual >= principal) {
    throw new LoanValidationError("Residual value must be less than the principal");
  }

  let payment: number;
  if (opts.paymentAmount != null && opts.paymentAmount > 0) {
    // Payment-driven: the schedule solves for the number of periods.
    payment = opts.paymentAmount;
    const firstInterest = principal * r;
    if (payment + extra <= firstInterest) {
      throw new LoanValidationError(
        `Payment of ${round2(payment + extra)} does not cover the first period's interest ` +
          `(${round2(firstInterest)}); the loan will never amortize. Increase the payment.`
      );
    }
  } else {
    // Term-driven: derive the payment from the term.
    const termMonths = opts.termMonths ?? 0;
    if (termMonths <= 0) {
      throw new LoanValidationError("Either a term or a payment amount is required");
    }
    const n = Math.max(1, Math.round((termMonths * periodsPerYear) / 12));
    payment = calculatePeriodPayment(principal, r, n, residual);
  }

  const start = parseYmdUTC(opts.startDate);
  const schedule: AmortizationRow[] = [];
  const accrual = new Map<string, number>();
  let balance = principal;
  let totalInterest = 0;
  let totalPayments = 0;
  let prevDate = start;
  // Safety cap: 100 years of periods. Payment-driven loans where the payment
  // barely exceeds interest would otherwise loop effectively forever.
  const maxPeriods = periodsPerYear * 100;

  for (let i = 1; balance - residual > 0.01; i++) {
    if (i > maxPeriods) {
      throw new LoanValidationError(
        "Payment barely covers interest — payoff exceeds 100 years. Increase the payment."
      );
    }
    const date = periodDate(start, i, freq);
    // What the lender actually charged for this payment date wins over the
    // calculation. The payment stays as it is, so the principal (and every
    // later balance) follows from the overridden interest.
    const override = overrides ? overrides[ymd(date)] : undefined;
    const overridden = typeof override === "number" && Number.isFinite(override) && override >= 0;
    const interest = overridden ? override : balance * r;
    let principalPortion = payment - interest + extra;
    if (principalPortion > balance - residual) principalPortion = balance - residual;

    const actualPayment = interest + principalPortion;
    balance -= principalPortion;
    totalInterest += interest;
    totalPayments += actualPayment;

    allocateInterestByMonth(prevDate, date, interest, accrual);
    prevDate = date;

    schedule.push({
      period: i,
      date: ymd(date),
      payment: round2(actualPayment),
      principal: round2(principalPortion),
      interest: round2(interest),
      extraPayment: round2(Math.min(extra, Math.max(principalPortion, 0))),
      balance: round2(Math.max(balance, 0)),
      ...(overridden ? { interestOverridden: true } : {}),
    });
  }

  const monthlyAccrual: MonthlyAccrualRow[] = Array.from(accrual.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, interest]) => ({ month, interest: round2(interest) }));

  const lastRow = schedule[schedule.length - 1];
  const paymentPerPeriod = round2(payment);
  return {
    monthlyPayment: paymentPerPeriod,
    paymentPerPeriod,
    monthlyEquivalentPayment: round2((payment * periodsPerYear) / 12),
    paymentFrequency: freq,
    periodsPerYear,
    totalPayments: round2(totalPayments),
    totalInterest: round2(totalInterest),
    payoffDate: lastRow?.date ?? opts.startDate,
    residualValue: round2(residual),
    schedule,
    monthlyAccrual,
    scheduleMode: "calculated",
  };
}

// Back-compat wrapper — the pre-v2 positional signature, used by existing
// REST/MCP callers and the what-if calculator. Term-driven only.
export function generateAmortizationSchedule(
  principal: number,
  annualRate: number,
  termMonths: number,
  startDate: string,
  extraPayment: number = 0,
  paymentFrequency: string = "monthly"
): LoanSummary {
  return buildLoanSchedule({
    principal,
    annualRate,
    termMonths,
    startDate,
    extraPayment,
    paymentFrequency,
  });
}

// Feature 12: Debt payoff strategies
export type Debt = {
  id: number;
  name: string;
  balance: number;
  rate: number;
  minPayment: number;
};

export type PayoffPlan = {
  strategy: string;
  totalInterest: number;
  totalMonths: number;
  order: { name: string; paidOffMonth: number }[];
};

export function calculateDebtPayoff(debts: Debt[], extraBudget: number, strategy: "avalanche" | "snowball"): PayoffPlan {
  const sorted = [...debts].sort((a, b) =>
    strategy === "avalanche" ? b.rate - a.rate : a.balance - b.balance
  );

  const balances = new Map(sorted.map((d) => [d.name, d.balance]));
  const order: { name: string; paidOffMonth: number }[] = [];
  let totalInterest = 0;
  let month = 0;
  let extra = extraBudget;

  while (Array.from(balances.values()).some((b) => b > 0.01) && month < 600) {
    month++;
    let availableExtra = extra;

    for (const debt of sorted) {
      const bal = balances.get(debt.name) ?? 0;
      if (bal <= 0.01) continue;

      const interest = (bal * debt.rate) / 100 / 12;
      totalInterest += interest;
      let payment = debt.minPayment;

      // First non-zero debt gets the extra
      if (sorted.find((d) => (balances.get(d.name) ?? 0) > 0.01)?.name === debt.name) {
        payment += availableExtra;
        availableExtra = 0;
      }

      const newBal = Math.max(bal + interest - payment, 0);
      balances.set(debt.name, newBal);

      if (newBal <= 0.01 && !order.find((o) => o.name === debt.name)) {
        order.push({ name: debt.name, paidOffMonth: month });
        extra += debt.minPayment;
      }
    }
  }

  return {
    strategy,
    totalInterest: Math.round(totalInterest * 100) / 100,
    totalMonths: month,
    order,
  };
}

// What-if scenario: extra payment impact
export function calculateExtraPaymentImpact(
  principal: number,
  annualRate: number,
  termMonths: number,
  startDate: string,
  extraAmounts: number[]
) {
  return extraAmounts.map((extra) => {
    const result = generateAmortizationSchedule(principal, annualRate, termMonths, startDate, extra);
    const baseline = generateAmortizationSchedule(principal, annualRate, termMonths, startDate, 0);
    return {
      extraPayment: extra,
      monthsSaved: baseline.schedule.length - result.schedule.length,
      interestSaved: Math.round((baseline.totalInterest - result.totalInterest) * 100) / 100,
      newPayoffDate: result.payoffDate,
      totalInterest: result.totalInterest,
    };
  });
}
