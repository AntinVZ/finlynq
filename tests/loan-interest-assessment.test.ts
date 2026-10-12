/**
 * Booked-versus-calculated interest verdict (2026-10-12).
 *
 * The owner's rule for this feature: judge on RECENT payments only. An extra
 * payment or a change to the loan shifts every later period, so an old payment
 * can differ from today's schedule for good reason and must not drive the
 * verdict or the suggested rate.
 */
import { describe, it, expect } from "vitest";
import {
  ASSESSMENT_MAX_PERIODS,
  assessBookedInterest,
  matchInterestToSchedule,
  type BookedInterest,
} from "@/lib/loans/interest-plan";
import { buildLoanSchedule } from "@/lib/loan-calculator";

const TODAY = "2026-10-12";
const schedule = [
  { period: 1, date: "2026-05-07", interest: 1.4 },
  { period: 2, date: "2026-06-07", interest: 1.3 },
  { period: 3, date: "2026-07-07", interest: 1.2 },
  { period: 4, date: "2026-08-07", interest: 1.12 },
  { period: 5, date: "2026-09-07", interest: 1.03 },
  { period: 6, date: "2026-10-07", interest: 0.93 },
  { period: 7, date: "2026-11-07", interest: 0.84 },
];
const bookedMap = (rows: Record<string, number>) =>
  new Map<string, BookedInterest>(
    Object.entries(rows).map(([date, amount], i) => [date, { amount, transactionIds: [i + 1] }]),
  );

describe("assessBookedInterest", () => {
  it("has no verdict from a single booked payment", () => {
    const a = assessBookedInterest(schedule, bookedMap({ "2026-10-07": 1.86 }), TODAY, 1);
    expect(a).toEqual({ status: "insufficient", periods: 1 });
  });

  it("has no verdict when nothing is booked", () => {
    expect(assessBookedInterest(schedule, new Map(), TODAY, 1).status).toBe("insufficient");
  });

  it("says in line when booked matches the schedule", () => {
    const a = assessBookedInterest(
      schedule,
      bookedMap({ "2026-09-07": 1.03, "2026-10-07": 0.93 }),
      TODAY,
      1,
    );
    expect(a.status).toBe("in_line");
    if (a.status !== "insufficient") {
      expect(a.suggestedRate).toBeNull();
      expect(a.fixedAmount).toBeNull();
    }
  });

  it("treats a cent of rounding per payment as in line", () => {
    const a = assessBookedInterest(
      schedule,
      bookedMap({ "2026-09-07": 1.04, "2026-10-07": 0.92 }),
      TODAY,
      1,
    );
    expect(a.status).toBe("in_line");
  });

  // The owner's own check: every booked entry doubled.
  it("doubled interest reads as over, and suggests double the rate", () => {
    const a = assessBookedInterest(
      schedule,
      bookedMap({ "2026-08-07": 2.24, "2026-09-07": 2.06, "2026-10-07": 1.86 }),
      TODAY,
      1,
    );
    expect(a.status).toBe("over");
    if (a.status === "insufficient") throw new Error("expected a verdict");
    expect(a.periods).toBe(3);
    expect(a.from).toBe("2026-08-07");
    expect(a.to).toBe("2026-10-07");
    expect(a.booked).toBe(6.16);
    expect(a.calculated).toBe(3.08);
    expect(a.ratio).toBeCloseTo(2, 5);
    expect(a.suggestedRate).toBe(2);
    expect(a.fixedAmount).toBeNull();
  });

  it("half the interest reads as under, and suggests half the rate", () => {
    const a = assessBookedInterest(
      schedule,
      bookedMap({ "2026-09-07": 0.515, "2026-10-07": 0.465 }),
      TODAY,
      5,
    );
    expect(a.status).toBe("under");
    if (a.status !== "insufficient") expect(a.suggestedRate).toBe(2.5);
  });

  // The rule that matters most: old payments are not evidence.
  it("ignores everything but the most recent booked payments", () => {
    const a = assessBookedInterest(
      schedule,
      bookedMap({
        "2026-05-07": 14, // ten times the schedule, but old
        "2026-06-07": 13,
        "2026-08-07": 1.12,
        "2026-09-07": 1.03,
        "2026-10-07": 0.93,
      }),
      TODAY,
      1,
    );
    expect(a.status).toBe("in_line");
    if (a.status !== "insufficient") {
      expect(a.periods).toBe(ASSESSMENT_MAX_PERIODS);
      expect(a.from).toBe("2026-08-07");
    }
  });

  it("never uses a payment older than twelve months", () => {
    const old = [
      { period: 1, date: "2025-08-07", interest: 2 },
      { period: 2, date: "2025-09-07", interest: 2 },
      { period: 3, date: "2026-10-07", interest: 1 },
    ];
    const a = assessBookedInterest(
      old,
      bookedMap({ "2025-08-07": 4, "2025-09-07": 4, "2026-10-07": 2 }),
      TODAY,
      1,
    );
    // Only the October payment is recent enough, and one payment is no pattern.
    expect(a).toEqual({ status: "insufficient", periods: 1 });
  });

  it("does not count a payment that has not come due yet", () => {
    const a = assessBookedInterest(
      schedule,
      bookedMap({ "2026-10-07": 1.86, "2026-11-07": 1.68 }),
      TODAY,
      1,
    );
    expect(a).toEqual({ status: "insufficient", periods: 1 });
  });

  it("offers no rate when the gap is not steady", () => {
    const a = assessBookedInterest(
      schedule,
      bookedMap({ "2026-08-07": 1.12, "2026-09-07": 3.09, "2026-10-07": 0.5 }),
      TODAY,
      1,
    );
    expect(a.status).toBe("inconsistent");
    if (a.status !== "insufficient") expect(a.suggestedRate).toBeNull();
  });

  it("spots a fixed charge: the same amount every payment while the schedule declines", () => {
    const a = assessBookedInterest(
      schedule,
      bookedMap({ "2026-08-07": 3, "2026-09-07": 3, "2026-10-07": 3 }),
      TODAY,
      1,
    );
    if (a.status === "insufficient") throw new Error("expected a verdict");
    expect(a.fixedAmount).toBe(3);
  });

  it("offers no rate for a 0% loan", () => {
    const zeroRate = [
      { period: 1, date: "2026-09-07", interest: 0.5 },
      { period: 2, date: "2026-10-07", interest: 0.5 },
    ];
    const a = assessBookedInterest(zeroRate, bookedMap({ "2026-09-07": 1, "2026-10-07": 1 }), TODAY, 0);
    if (a.status !== "insufficient") expect(a.suggestedRate).toBeNull();
  });

  // End to end through the real calculator and the ledger matcher: applying
  // the suggested rate must make the schedule agree with what was charged.
  it("applying the suggested rate brings the schedule in line", () => {
    const loan = { principal: 12000, termMonths: 24, startDate: "2026-04-07" };
    const charged = buildLoanSchedule({ ...loan, annualRate: 6 }).schedule;
    const wrong = buildLoanSchedule({ ...loan, annualRate: 4 }).schedule;
    const txs = charged
      .filter((r) => r.date <= TODAY)
      .map((r, i) => ({ transactionId: i + 1, date: r.date, amount: -r.interest }));

    const before = assessBookedInterest(wrong, matchInterestToSchedule(wrong, txs).booked, TODAY, 4);
    expect(before.status).toBe("over");
    if (before.status === "insufficient") throw new Error("expected a verdict");
    expect(before.suggestedRate).toBeCloseTo(6, 1);

    const fixed = buildLoanSchedule({ ...loan, annualRate: before.suggestedRate! }).schedule;
    const after = assessBookedInterest(
      fixed,
      matchInterestToSchedule(fixed, txs).booked,
      TODAY,
      before.suggestedRate!,
    );
    expect(after.status).toBe("in_line");
  });
});
