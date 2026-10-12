/**
 * Pure helpers for booking loan interest into the loan's linked account
 * (2026-10-12). No DB, no fetch — the route, the MCP tool and the Loans page
 * all read these, so the three surfaces agree on which periods are due and on
 * the sign of the entry.
 *
 * The model: a loan payment is a plain transfer into the loan account. The
 * interest is a SEPARATE expense entry on that same account. It adds to what
 * is owed, the payment takes it off, and the balance falls by the principal.
 */

/** The fields of a schedule row this module needs (see `AmortizationRow`). */
export type InterestScheduleRow = { period: number; date: string; interest: number };

/** Interest below half a cent rounds to nothing and is not worth an entry. */
const MIN_INTEREST = 0.005;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Schedule rows whose payment date has arrived and whose interest has not been
 * booked yet. `postedDates` holds the `period_date` of every existing posting.
 */
export function dueUnpostedInterest<R extends InterestScheduleRow>(
  schedule: readonly R[],
  postedDates: ReadonlySet<string>,
  today: string,
): R[] {
  return schedule.filter(
    (r) => r.date <= today && r.interest >= MIN_INTEREST && !postedDates.has(r.date),
  );
}

/**
 * The amount as stored on the loan account. Liability accounts carry a
 * negative balance while money is owed, and interest increases what is owed,
 * so the entry is always negative whatever sign the caller passed.
 */
export function interestLedgerAmount(interest: number): number {
  return -round2(Math.abs(interest));
}

/** True when `amount` is a usable interest figure (finite, at least a cent). */
export function isPostableInterest(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && Math.abs(amount) >= 0.01;
}
