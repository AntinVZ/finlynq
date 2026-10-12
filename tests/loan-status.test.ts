import { describe, it, expect } from "vitest";
import { isLoanCompleted } from "@/lib/loan-status";

describe("isLoanCompleted", () => {
  it("is true once nothing is left to pay", () => {
    expect(isLoanCompleted({ remainingBalance: 0, periodsRemaining: 0 })).toBe(true);
    expect(isLoanCompleted({ remainingBalance: 1.49e-8, periodsRemaining: 0 })).toBe(true);
    expect(isLoanCompleted({ remainingBalance: 0.4, periodsRemaining: 1 })).toBe(true);
  });
  it("is false while a balance or periods remain", () => {
    expect(isLoanCompleted({ remainingBalance: 149_549_995, periodsRemaining: 34 })).toBe(false);
    expect(isLoanCompleted({ remainingBalance: 13_193, periodsRemaining: 1 })).toBe(false);
  });
  it("is false for a loan the server couldn't schedule (null balance/periods)", () => {
    expect(isLoanCompleted({ remainingBalance: null, periodsRemaining: null })).toBe(false);
  });
  // A calculated schedule always runs to payoff, so "no periods left" means
  // done (a lease ends with its residual still on the balance). A manual one is
  // only as long as the rows supplied: three rows typed in and the loan still
  // owing 9,487 filed it under "Completed" (found on dev, 2026-10-12).
  it("a manual schedule that stops short of payoff is not completed", () => {
    expect(isLoanCompleted({ remainingBalance: 9487, periodsRemaining: 0, scheduleMode: "manual" })).toBe(false);
    expect(isLoanCompleted({ remainingBalance: 0, periodsRemaining: 0, scheduleMode: "manual" })).toBe(true);
    expect(isLoanCompleted({ remainingBalance: 0.3, periodsRemaining: 4, scheduleMode: "manual" })).toBe(true);
  });
  it("a calculated schedule with no periods left is still completed (lease residual)", () => {
    expect(isLoanCompleted({ remainingBalance: 5000, periodsRemaining: 0, scheduleMode: "calculated" })).toBe(true);
    expect(isLoanCompleted({ remainingBalance: 5000, periodsRemaining: 0 })).toBe(true);
  });
});
