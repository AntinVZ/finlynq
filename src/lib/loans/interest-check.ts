/**
 * Read-only side of loan interest: what the ledger holds, and whether it
 * agrees with the schedule (2026-10-12). SERVER ONLY — reaches `db`.
 *
 * Kept apart from `interest-entries.ts` (which writes transactions) on
 * purpose: the dashboard's Action Center imports this, and it must not drag
 * the transaction-writing stack onto the dashboard's hot path.
 */

import { db, schema } from "@/db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { buildLoanSchedule, LoanValidationError, loanScheduleExtras } from "@/lib/loan-calculator";
import { todayISO } from "@/lib/utils/date";
import {
  assessBookedInterest,
  matchInterestToSchedule,
  type InterestAssessment,
  type InterestScheduleRow,
  type InterestTx,
} from "./interest-plan";

export type LoanRow = typeof schema.loans.$inferSelect;

/** The loan's schedule rows, with its own manual schedule / interest overrides applied. */
export function scheduleRowsFor(loan: LoanRow): InterestScheduleRow[] {
  return buildLoanSchedule({
    principal: loan.principal,
    annualRate: loan.annualRate,
    termMonths: loan.termMonths,
    startDate: loan.startDate,
    paymentAmount: loan.paymentAmount,
    paymentFrequency: loan.paymentFrequency,
    extraPayment: loan.extraPayment ?? 0,
    residualValue: loan.residualValue,
    ...loanScheduleExtras(loan),
  }).schedule;
}

/**
 * Interest transactions on an account: everything in the given categories that
 * is not one leg of a transfer (a payment mis-filed under the interest category
 * must not read as negative interest).
 */
export async function loadInterestTransactions(
  userId: string,
  accountId: number,
  categoryIds: number[],
): Promise<InterestTx[]> {
  if (!categoryIds.length) return [];
  const rows = await db
    .select({
      transactionId: schema.transactions.id,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.accountId, accountId),
        inArray(schema.transactions.categoryId, categoryIds),
        isNull(schema.transactions.linkId),
      ),
    )
    .all();
  return rows.map((r) => ({
    transactionId: r.transactionId,
    date: r.date,
    amount: Number(r.amount),
  }));
}

/**
 * Booked-versus-calculated verdict for one loan row, or null when there is
 * nothing to compare (no linked account, no interest category, or a loan that
 * cannot be scheduled). See `assessBookedInterest` for the rules, above all
 * that only the most recent booked payments count.
 */
export async function assessLoanRow(
  userId: string,
  loan: LoanRow,
): Promise<InterestAssessment | null> {
  if (loan.accountId == null || loan.interestCategoryId == null) return null;
  let schedule: InterestScheduleRow[];
  try {
    schedule = scheduleRowsFor(loan);
  } catch (e) {
    if (e instanceof LoanValidationError) return null;
    throw e;
  }
  const txs = await loadInterestTransactions(userId, loan.accountId, [loan.interestCategoryId]);
  const { booked } = matchInterestToSchedule(schedule, txs);
  // A manual schedule's interest is not derived from the rate, so no rate is suggested.
  const manual = loanScheduleExtras(loan).manualSchedule != null;
  return assessBookedInterest(schedule, booked, todayISO(), manual ? 0 : loan.annualRate);
}

/** The verdict for one of the caller's loans by id; null when unknown or not comparable. */
export async function assessLoanInterest(
  userId: string,
  loanId: number,
): Promise<InterestAssessment | null> {
  const loan = await db
    .select()
    .from(schema.loans)
    .where(and(eq(schema.loans.id, loanId), eq(schema.loans.userId, userId)))
    .get();
  return loan ? assessLoanRow(userId, loan) : null;
}

/**
 * Every loan of the user's that has a verdict. Only loans with a linked
 * account AND an interest category are read at all, so a user who does not
 * book loan interest costs one indexed query.
 */
export async function assessAllLoansInterest(
  userId: string,
): Promise<Array<{ loan: LoanRow; assessment: InterestAssessment }>> {
  const loans = await db
    .select()
    .from(schema.loans)
    .where(
      and(
        eq(schema.loans.userId, userId),
        isNotNull(schema.loans.accountId),
        isNotNull(schema.loans.interestCategoryId),
      ),
    )
    .all();
  const out: Array<{ loan: LoanRow; assessment: InterestAssessment }> = [];
  for (const loan of loans) {
    const assessment = await assessLoanRow(userId, loan);
    if (assessment && assessment.status !== "insufficient") out.push({ loan, assessment });
  }
  return out;
}

/** One sentence naming the window a verdict covers. Shown wherever a verdict is. */
export function assessmentWindowNote(a: InterestAssessment): string {
  if (a.status === "insufficient") return "";
  return `Based on the last ${a.periods} booked payments (${a.from} to ${a.to}); older payments are not compared.`;
}
