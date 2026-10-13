/**
 * Paid off: nothing left to pay (balance rounds to zero or no periods remain).
 *
 * `GET /api/loans` returns `remainingBalance`/`periodsRemaining` as `null` for a
 * loan it couldn't schedule (`dataIntegrity` rows). That is NOT paid off — it is
 * the loan most in need of attention — and `null <= 0.5` is `true` in JS, so an
 * unguarded comparison filed it under the collapsed "Completed" section.
 *
 * A MANUAL schedule is only as long as the rows the user supplied. A calculated
 * schedule always runs to payoff, so "no periods remain" means paid off; a
 * manual one can simply stop (three rows typed in, a partial upload) with most
 * of the loan still owed. For those, only the balance decides.
 */
export function isLoanCompleted(loan: {
  remainingBalance: number | null;
  periodsRemaining: number | null;
  scheduleMode?: "calculated" | "manual" | null;
}): boolean {
  if (loan.remainingBalance == null || loan.periodsRemaining == null) return false;
  if (loan.remainingBalance <= 0.5) return true;
  return loan.scheduleMode !== "manual" && loan.periodsRemaining <= 0;
}
