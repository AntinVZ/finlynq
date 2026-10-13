/**
 * Reading and changing a loan's own schedule (2026-10-12). SERVER ONLY —
 * reaches `db`. The one write path for REST `/api/loans/schedule` and the MCP
 * `manage_loans` schedule ops, so both validate and store the same way.
 *
 * A loan's schedule is calculated unless the user says otherwise, in one of
 * two ways (both stored on the loan row, see `loanScheduleExtras`):
 *
 *   - interest overrides: the interest actually charged on specific payment
 *     dates of the calculated schedule;
 *   - a manual schedule: complete rows the user supplied, which replace the
 *     calculation.
 *
 * Setting a manual schedule drops any interest overrides: they are edits to
 * calculated rows, and the manual rows already say what each payment's
 * interest is.
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { AppError } from "@/lib/validate";
import {
  buildLoanSchedule,
  loanScheduleExtras,
  LoanValidationError,
  normalizeInterestOverrides,
  normalizeManualSchedule,
  type LoanScheduleOptions,
  type LoanSummary,
  type ManualScheduleRow,
} from "@/lib/loan-calculator";

type LoanRow = typeof schema.loans.$inferSelect;

export type LoanScheduleState = {
  mode: "calculated" | "manual";
  manualSchedule: ManualScheduleRow[] | null;
  interestOverrides: Record<string, number>;
};

async function loadLoan(userId: string, loanId: number): Promise<LoanRow> {
  const loan = await db
    .select()
    .from(schema.loans)
    .where(and(eq(schema.loans.id, loanId), eq(schema.loans.userId, userId)))
    .get();
  if (!loan) throw new AppError("Loan not found.", 404);
  return loan;
}

function stateOf(loan: object): LoanScheduleState {
  const { manualSchedule, interestOverrides } = loanScheduleExtras(loan);
  return {
    mode: manualSchedule ? "manual" : "calculated",
    manualSchedule: manualSchedule ? [...manualSchedule] : null,
    interestOverrides: manualSchedule ? {} : { ...(interestOverrides ?? {}) },
  };
}

function build(
  loan: LoanRow,
  extras: Pick<LoanScheduleOptions, "manualSchedule" | "interestOverrides">,
): LoanSummary {
  return buildLoanSchedule({
    principal: loan.principal,
    annualRate: loan.annualRate,
    termMonths: loan.termMonths,
    startDate: loan.startDate,
    paymentAmount: loan.paymentAmount,
    paymentFrequency: loan.paymentFrequency,
    extraPayment: loan.extraPayment ?? 0,
    residualValue: loan.residualValue,
    // The method is a property of the loan, not of the change being applied.
    interestMethod: loan.interestMethod,
    interestAmount: loan.interestAmount,
    ...extras,
  });
}

/** The loan's schedule as every surface computes it, with its customizations applied. */
export async function readLoanSchedule(
  userId: string,
  loanId: number,
): Promise<LoanScheduleState & { summary: LoanSummary }> {
  const loan = await loadLoan(userId, loanId);
  const state = stateOf(loan);
  try {
    return { ...state, summary: build(loan, loanScheduleExtras(loan)) };
  } catch (e) {
    if (e instanceof LoanValidationError) throw new AppError(e.message, 400);
    throw e;
  }
}

export type ScheduleChange = {
  /** Rows to store as the manual schedule; `null` goes back to calculated. Omit to leave as is. */
  manualSchedule?: unknown;
  /**
   * With `manualSchedule`: merge these rows into the existing schedule by date
   * (starting from the current rows, calculated or manual) instead of
   * replacing it. Lets a caller correct a few payments without resending all.
   */
  mergeRows?: boolean;
  /** Date -> interest for calculated rows; a `null` amount removes that override. Merged into what is stored. */
  interestOverrides?: Record<string, number | null> | null;
  /** Drop every interest override first. */
  clearInterestOverrides?: boolean;
};

/**
 * Apply a change to a loan's schedule. Validates by building the resulting
 * schedule, so nothing that cannot be scheduled is ever stored. Refusals are
 * AppError 400s carrying a message the user can act on.
 */
export async function saveLoanSchedule(
  userId: string,
  loanId: number,
  change: ScheduleChange,
): Promise<LoanScheduleState & { summary: LoanSummary }> {
  const loan = await loadLoan(userId, loanId);
  const current = stateOf(loan);
  let manual = current.manualSchedule;
  let overrides: Record<string, number> = current.interestOverrides;

  try {
    if (change.manualSchedule !== undefined) {
      if (change.manualSchedule === null) {
        manual = null;
      } else {
        let rows = normalizeManualSchedule(change.manualSchedule);
        if (change.mergeRows) {
          // Start from what the loan shows today, then lay the new rows over it.
          const base = build(loan, { manualSchedule: manual, interestOverrides: overrides });
          const byDate = new Map<string, ManualScheduleRow>(
            base.schedule.map((r) => [r.date, { date: r.date, payment: r.payment, interest: r.interest }]),
          );
          for (const r of rows) byDate.set(r.date, r);
          rows = normalizeManualSchedule([...byDate.values()]);
        }
        manual = rows;
      }
      // Overrides are edits to calculated rows; a manual schedule replaces those rows.
      if (manual) overrides = {};
    }

    if (change.clearInterestOverrides) overrides = {};
    if (change.interestOverrides) {
      if (manual) {
        throw new AppError(
          "This loan has a manual schedule. Change the row in the schedule itself, or go back to the calculated schedule first.",
          400,
        );
      }
      const next = { ...overrides };
      const toSet: Record<string, number> = {};
      for (const [date, amount] of Object.entries(change.interestOverrides)) {
        if (amount == null) delete next[date];
        else toSet[date] = amount;
      }
      overrides = { ...next, ...normalizeInterestOverrides(toSet) };
    }

    const summary = build(loan, {
      manualSchedule: manual,
      interestOverrides: Object.keys(overrides).length ? overrides : null,
    });
    // An override for a date that is not a payment date would be stored and
    // then never applied, so the user would see nothing change.
    if (!manual) {
      const dates = new Set(summary.schedule.map((r) => r.date));
      const stray = Object.keys(overrides).filter((d) => !dates.has(d)).sort();
      if (stray.length) {
        throw new AppError(
          `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} not a payment date on this loan's schedule.`,
          400,
        );
      }
    }

    await db
      .update(schema.loans)
      .set({
        manualSchedule: manual,
        interestOverrides: Object.keys(overrides).length ? overrides : null,
      })
      .where(and(eq(schema.loans.id, loanId), eq(schema.loans.userId, userId)));

    return {
      mode: manual ? "manual" : "calculated",
      manualSchedule: manual,
      interestOverrides: manual ? {} : overrides,
      summary,
    };
  } catch (e) {
    if (e instanceof LoanValidationError) throw new AppError(e.message, 400);
    throw e;
  }
}
