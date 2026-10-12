/**
 * Pure helpers for loan interest entries (2026-10-12). No DB, no fetch — the
 * route, the MCP tool and the Loans page all read these, so the three surfaces
 * agree on which periods are booked, which are due, and the sign of an entry.
 *
 * The model: a loan payment is a plain transfer into the loan account. The
 * interest is a SEPARATE expense transaction on that same account. It adds to
 * what is owed, the payment takes it off, and the balance falls by the
 * principal.
 *
 * "Booked" is decided by reading the ledger, not a tracking table: every
 * transaction on the loan account in the loan's interest category counts,
 * whether it was typed in, recorded by an assistant, or generated from the
 * schedule. Each one is credited to the schedule period whose payment date is
 * nearest.
 */

/** The fields of a schedule row this module needs (see `AmortizationRow`). */
export type InterestScheduleRow = { period: number; date: string; interest: number };

/** One interest transaction on the loan account (amount as stored: negative). */
export type InterestTx = { transactionId: number; date: string; amount: number };

/** What the ledger holds for one schedule period. */
export type BookedInterest = {
  /** Interest charged, as a positive figure (refunds net against charges). */
  amount: number;
  transactionIds: number[];
};

/** Interest below half a cent rounds to nothing and is not worth an entry. */
const MIN_INTEREST = 0.005;
const DAY_MS = 86_400_000;

const round2 = (n: number) => Math.round(n * 100) / 100;
const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);

/**
 * Credit each interest transaction to the schedule period whose payment date
 * is nearest (a tie goes to the earlier period). Lenders rarely post interest
 * on the exact payment date, so an exact-date match would miss most of them.
 *
 * A transaction more than one payment interval outside the schedule's own
 * date range belongs to no period and comes back in `unmatched`.
 *
 * A period whose transactions net to nothing (a charge and its reversal) is
 * left out of `booked`, so it still reads as due.
 */
export function matchInterestToSchedule(
  schedule: readonly InterestScheduleRow[],
  txs: readonly InterestTx[],
): { booked: Map<string, BookedInterest>; unmatched: InterestTx[] } {
  const booked = new Map<string, BookedInterest>();
  const unmatched: InterestTx[] = [];
  if (!schedule.length) return { booked, unmatched: [...txs] };

  const days = schedule.map((r) => dayNumber(r.date));
  const interval = days.length > 1 ? Math.max(1, days[1] - days[0]) : 31;
  const first = days[0];
  const last = days[days.length - 1];

  for (const tx of txs) {
    const d = dayNumber(tx.date);
    if (!Number.isFinite(d) || d < first - interval || d > last + interval) {
      unmatched.push(tx);
      continue;
    }
    let best = 0;
    for (let i = 1; i < days.length; i++) {
      // Strict `<` keeps the earlier period on a tie.
      if (Math.abs(days[i] - d) < Math.abs(days[best] - d)) best = i;
    }
    const key = schedule[best].date;
    const entry = booked.get(key) ?? { amount: 0, transactionIds: [] };
    entry.amount = round2(entry.amount - tx.amount);
    entry.transactionIds.push(tx.transactionId);
    booked.set(key, entry);
  }

  for (const [key, entry] of booked) {
    if (entry.amount < MIN_INTEREST) booked.delete(key);
  }
  return { booked, unmatched };
}

/**
 * Schedule rows whose payment date has arrived and whose interest is not in
 * the ledger yet. `bookedDates` is the key set of `matchInterestToSchedule`.
 */
export function dueUnpostedInterest<R extends InterestScheduleRow>(
  schedule: readonly R[],
  bookedDates: ReadonlySet<string>,
  today: string,
): R[] {
  return schedule.filter(
    (r) => r.date <= today && r.interest >= MIN_INTEREST && !bookedDates.has(r.date),
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
