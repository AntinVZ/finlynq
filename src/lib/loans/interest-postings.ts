/**
 * Booking loan interest into the loan's linked account (2026-10-12).
 * SERVER ONLY — reaches `db`. Client code imports `interest-plan.ts` instead.
 *
 * One chokepoint for both surfaces (REST `/api/loans/interest` and MCP
 * `manage_loans(op:"post_interest")`): it owns the ownership checks, the
 * "already posted" guard, and the atomic transaction + posting write.
 */

import { db, schema, withDbTransaction } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTransaction, getAccountById } from "@/lib/queries";
import { encryptField } from "@/lib/crypto/envelope";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { markCashSnapshotsDirty } from "@/lib/portfolio/snapshots/cash-dirty";
import { verifyOwnership } from "@/lib/verify-ownership";
import { AppError } from "@/lib/validate";
import { isPgErrorCode } from "@/lib/db-utils";
import { getDisplayCurrency } from "@/lib/fx-service";
import { computeReportingFields } from "@/lib/fx/reporting-amount";
import { buildLoanSchedule, LoanValidationError } from "@/lib/loan-calculator";
import type { TransactionSource } from "@/lib/tx-source";
import { interestLedgerAmount, isPostableInterest } from "./interest-plan";

export const LOAN_INTEREST_PAYEE = "Loan interest";

export type InterestPosting = {
  periodDate: string;
  transactionId: number;
  /** As stored on the loan account (negative). */
  amount: number;
  date: string;
};

export type InterestEntryInput = {
  /** Date of the schedule row this interest belongs to (YYYY-MM-DD). */
  periodDate: string;
  /** Interest for that period, as a positive figure in the account's currency. */
  amount: number;
  /** Transaction date. Defaults to `periodDate`. */
  date?: string;
};

/** Every interest posting for one loan, oldest period first. */
export async function listInterestPostings(
  userId: string,
  loanId: number,
): Promise<InterestPosting[]> {
  const rows = await db
    .select({
      periodDate: schema.loanInterestPostings.periodDate,
      transactionId: schema.loanInterestPostings.transactionId,
      amount: schema.transactions.amount,
      date: schema.transactions.date,
    })
    .from(schema.loanInterestPostings)
    .innerJoin(
      schema.transactions,
      eq(schema.transactions.id, schema.loanInterestPostings.transactionId),
    )
    .where(
      and(
        eq(schema.loanInterestPostings.userId, userId),
        eq(schema.loanInterestPostings.loanId, loanId),
      ),
    )
    .all();
  return rows
    .map((r) => ({
      periodDate: r.periodDate,
      transactionId: r.transactionId,
      amount: Number(r.amount),
      date: r.date,
    }))
    .sort((a, b) => a.periodDate.localeCompare(b.periodDate));
}

/**
 * Book one or more periods' interest as expense transactions on the loan's
 * linked account. All-or-nothing: every transaction and its posting row commit
 * together, so a failure part-way leaves nothing behind.
 *
 * Refuses (AppError) when the loan is missing or unlinked, the account is an
 * investment account, a period is not on the loan's schedule, or a period is
 * already posted. Nothing is written in any of those cases.
 */
export async function postLoanInterest(
  userId: string,
  dek: Buffer,
  input: {
    loanId: number;
    categoryId: number;
    entries: InterestEntryInput[];
    source: TransactionSource;
  },
): Promise<InterestPosting[]> {
  const { loanId, categoryId, entries, source } = input;
  if (!entries.length) throw new AppError("No interest entries to post.", 400);

  const loan = await db
    .select()
    .from(schema.loans)
    .where(and(eq(schema.loans.id, loanId), eq(schema.loans.userId, userId)))
    .get();
  if (!loan) throw new AppError("Loan not found.", 404);
  if (loan.accountId == null) {
    throw new AppError(
      "Link this loan to an account first. Interest is booked into the loan's own account.",
      400,
    );
  }
  const account = await getAccountById(loan.accountId, userId);
  if (!account) throw new AppError("The loan's linked account no longer exists.", 400);
  if (account.isInvestment) {
    throw new AppError("Interest can't be booked into an investment account.", 400);
  }
  // 404-shaped on a foreign id, like every other write (anti-enumeration).
  await verifyOwnership(userId, { categoryIds: [categoryId] });

  // Each entry must name a real row of the loan's CURRENT schedule. A date
  // that matches no row would be recorded and then never shown anywhere.
  let scheduleDates: Set<string>;
  try {
    const summary = buildLoanSchedule({
      principal: loan.principal,
      annualRate: loan.annualRate,
      termMonths: loan.termMonths,
      startDate: loan.startDate,
      paymentAmount: loan.paymentAmount,
      paymentFrequency: loan.paymentFrequency,
      extraPayment: loan.extraPayment ?? 0,
      residualValue: loan.residualValue,
    });
    scheduleDates = new Set(summary.schedule.map((r) => r.date));
  } catch (e) {
    if (e instanceof LoanValidationError) throw new AppError(e.message, 400);
    throw e;
  }

  const seen = new Set<string>();
  for (const e of entries) {
    if (!scheduleDates.has(e.periodDate)) {
      throw new AppError(`${e.periodDate} is not a payment date on this loan's schedule.`, 400);
    }
    if (seen.has(e.periodDate)) {
      throw new AppError(`${e.periodDate} is listed more than once.`, 400);
    }
    seen.add(e.periodDate);
    if (!isPostableInterest(e.amount)) {
      throw new AppError(`Interest for ${e.periodDate} must be at least 0.01.`, 400);
    }
  }

  const already = await db
    .select({ periodDate: schema.loanInterestPostings.periodDate })
    .from(schema.loanInterestPostings)
    .where(
      and(
        eq(schema.loanInterestPostings.loanId, loanId),
        inArray(schema.loanInterestPostings.periodDate, [...seen]),
      ),
    )
    .all();
  if (already.length) {
    const dates = already.map((r) => r.periodDate).sort().join(", ");
    throw new AppError(`Interest is already posted for ${dates}.`, 409);
  }

  const loanName = decryptName(loan.nameCt, dek, null) ?? "";
  // Resolve the historical reporting amounts BEFORE opening the transaction:
  // the FX lookup can reach the network, which must never happen while a pool
  // client is held.
  const displayCurrency = await getDisplayCurrency(userId);
  const prepared = await Promise.all(
    entries.map(async (e) => {
      const date = e.date ?? e.periodDate;
      const amount = interestLedgerAmount(e.amount);
      const reporting = await computeReportingFields({
        userId,
        accountCurrency: account.currency,
        amount,
        date,
        reportingCurrency: displayCurrency,
      });
      return { periodDate: e.periodDate, date, amount, reporting };
    }),
  );

  let created: InterestPosting[];
  try {
    created = await withDbTransaction(async () => {
      const out: InterestPosting[] = [];
      for (const p of prepared) {
        const note = loanName
          ? `${loanName}: interest for the payment due ${p.periodDate}`
          : `Interest for the payment due ${p.periodDate}`;
        const tx = await createTransaction(
          userId,
          {
            date: p.date,
            accountId: account.id,
            categoryId,
            currency: account.currency,
            amount: p.amount,
            payee: encryptField(dek, LOAN_INTEREST_PAYEE),
            note: encryptField(dek, note),
            source,
            ...(p.reporting ?? {}),
          },
          dek,
        );
        if (!tx) throw new AppError("Failed to create the interest transaction.", 500);
        await db.insert(schema.loanInterestPostings).values({
          userId,
          loanId,
          periodDate: p.periodDate,
          transactionId: tx.id,
        });
        out.push({
          periodDate: p.periodDate,
          transactionId: tx.id,
          amount: Number(tx.amount),
          date: tx.date,
        });
      }
      return out;
    });
  } catch (e) {
    // Two requests racing for the same period: the unique index refuses the
    // second, and the rollback takes its transaction with it.
    if (isPgErrorCode(e, "23505")) {
      throw new AppError(
        "Interest for one of these periods was just posted by another request.",
        409,
      );
    }
    throw e;
  }

  invalidateUserTxCache(userId);
  const earliest = prepared.map((p) => p.date).sort()[0];
  await markCashSnapshotsDirty(userId, account.id, earliest);
  return created;
}
