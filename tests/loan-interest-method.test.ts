/**
 * How a loan's interest is worked out (2026-10-12, in-app feedback).
 *
 * A user arrived with "60 payments of 587, 87 of it interest every time". That
 * is how such loans are advertised, not how interest accrues, so there are two
 * ways to enter it:
 *
 *   flat  : the same interest with every payment, as the lender describes it.
 *   total : the interest over the whole loan, spread the standard way (level
 *           payment, the rate solved to give exactly that total).
 *
 * Both report the comparable yearly rate, which is the honest figure: the same
 * 5,220 of interest on 30,000 over five years reads as 3.48% a year quoted
 * flat, and costs about 6.5% a year on the balance actually owed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLoanSchedule,
  INTEREST_METHODS,
  loanScheduleExtras,
  LoanValidationError,
  normalizeInterestMethod,
} from "@/lib/loan-calculator";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
// The loan from the feedback: 30,000 over 60 months, 587 a month.
const loan = { principal: 30000, annualRate: 0, startDate: "2026-01-15" };
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe("flat: the same interest with every payment", () => {
  const s = buildLoanSchedule({ ...loan, paymentAmount: 587, interestMethod: "flat", interestAmount: 87 });

  it("every payment carries 87 interest and takes 500 off the loan", () => {
    expect(s.schedule).toHaveLength(60);
    expect(new Set(s.schedule.map((r) => r.interest))).toEqual(new Set([87]));
    expect(new Set(s.schedule.map((r) => r.principal))).toEqual(new Set([500]));
    expect(new Set(s.schedule.map((r) => r.payment))).toEqual(new Set([587]));
  });

  it("totals 5,220 of interest and ends at zero", () => {
    expect(s.totalInterest).toBe(5220);
    expect(s.schedule[59].balance).toBe(0);
    expect(s.interestMethod).toBe("flat");
    expect(s.scheduleMode).toBe("calculated");
  });

  // 87 x 12 / 30,000 = 3.48% is the advertised figure. On the balance really
  // owed it is nearly twice that, and that is what the schedule must report.
  it("reports the comparable yearly rate, well above the advertised one", () => {
    expect(s.effectiveAnnualRate).toBeGreaterThan(6);
    expect(s.effectiveAnnualRate).toBeLessThan(7);
  });

  it("works from a term too: the payment is principal over the term plus the interest", () => {
    const t = buildLoanSchedule({ ...loan, termMonths: 60, interestMethod: "flat", interestAmount: 87 });
    expect(t.paymentPerPeriod).toBe(587);
    expect(t.schedule).toHaveLength(60);
    expect(t.totalInterest).toBe(5220);
  });

  it("ignores the annual rate", () => {
    const t = buildLoanSchedule({ ...loan, annualRate: 25, paymentAmount: 587, interestMethod: "flat", interestAmount: 87 });
    expect(t.schedule.map((r) => r.interest)).toEqual(s.schedule.map((r) => r.interest));
  });

  it("an edited payment still wins over the flat amount", () => {
    const second = s.schedule[1].date;
    const t = buildLoanSchedule({
      ...loan,
      paymentAmount: 587,
      interestMethod: "flat",
      interestAmount: 87,
      interestOverrides: { [second]: 120 },
    });
    expect(t.schedule[1].interest).toBe(120);
    expect(t.schedule[0].interest).toBe(87);
    expect(t.schedule[2].interest).toBe(87);
  });

  it("refuses a payment that does not cover the interest", () => {
    expect(() =>
      buildLoanSchedule({ ...loan, paymentAmount: 80, interestMethod: "flat", interestAmount: 87 }),
    ).toThrow(LoanValidationError);
  });

  it("refuses a flat loan with no amount", () => {
    expect(() => buildLoanSchedule({ ...loan, paymentAmount: 587, interestMethod: "flat" })).toThrow(
      /interest charged with each payment/,
    );
  });
});

describe("total: the whole loan's interest, spread the standard way", () => {
  const s = buildLoanSchedule({ ...loan, termMonths: 60, interestMethod: "total", interestAmount: 5220 });

  it("keeps the payment level at 587 for 60 payments", () => {
    expect(s.schedule).toHaveLength(60);
    expect(s.paymentPerPeriod).toBe(587);
    for (const r of s.schedule.slice(0, 59)) expect(r.payment).toBe(587);
  });

  it("adds up to the stated total and pays the loan off", () => {
    expect(Math.abs(s.totalInterest - 5220)).toBeLessThan(0.5);
    expect(Math.abs(sum(s.schedule.map((r) => r.principal)) - 30000)).toBeLessThan(0.5);
    expect(s.schedule[59].balance).toBeLessThan(0.5);
  });

  // The point of this method: the same money, allocated the way interest
  // actually accrues. More than 87 at the start, less than 87 at the end.
  it("front-loads the interest instead of charging 87 every time", () => {
    const interest = s.schedule.map((r) => r.interest);
    expect(interest[0]).toBeGreaterThan(87);
    expect(interest[59]).toBeLessThan(87);
    for (let i = 1; i < interest.length; i++) expect(interest[i]).toBeLessThanOrEqual(interest[i - 1]);
  });

  it("carries the same yearly rate as the flat loan it is the honest version of", () => {
    const flat = buildLoanSchedule({ ...loan, paymentAmount: 587, interestMethod: "flat", interestAmount: 87 });
    expect(Math.abs((s.effectiveAnnualRate ?? 0) - (flat.effectiveAnnualRate ?? 0))).toBeLessThan(0.02);
  });

  it("works from a payment instead of a term", () => {
    const t = buildLoanSchedule({ ...loan, paymentAmount: 587, interestMethod: "total", interestAmount: 5220 });
    expect(t.schedule).toHaveLength(60);
    expect(Math.abs(t.totalInterest - 5220)).toBeLessThan(0.5);
  });

  it("a total of zero is an interest-free loan", () => {
    const t = buildLoanSchedule({ ...loan, termMonths: 60, interestMethod: "total", interestAmount: 0 });
    expect(t.totalInterest).toBe(0);
    expect(t.paymentPerPeriod).toBe(500);
    expect(t.effectiveAnnualRate).toBe(0);
  });

  it("refuses with neither a term nor a payment, and with no amount", () => {
    expect(() => buildLoanSchedule({ ...loan, interestMethod: "total", interestAmount: 5220 })).toThrow(
      LoanValidationError,
    );
    expect(() => buildLoanSchedule({ ...loan, termMonths: 60, interestMethod: "total" })).toThrow(
      /total interest for the whole loan/,
    );
  });
});

describe("rate stays the default and is unchanged", () => {
  const base = { principal: 12000, annualRate: 6, termMonths: 24, startDate: "2026-01-15" };

  it("a loan with no method behaves exactly as before", () => {
    const a = buildLoanSchedule(base);
    const b = buildLoanSchedule({ ...base, interestMethod: "rate", interestAmount: 999 });
    const c = buildLoanSchedule({ ...base, interestMethod: null });
    expect(b.schedule).toEqual(a.schedule);
    expect(c.schedule).toEqual(a.schedule);
    expect(a.interestMethod).toBe("rate");
    expect(a.effectiveAnnualRate).toBe(6);
  });

  it("an unknown method degrades to rate instead of throwing", () => {
    expect(normalizeInterestMethod("compound")).toBe("rate");
    expect(normalizeInterestMethod(undefined)).toBe("rate");
    expect(buildLoanSchedule({ ...base, interestMethod: "compound" }).schedule).toEqual(
      buildLoanSchedule(base).schedule,
    );
  });

  it("a manual schedule still replaces everything, whatever the method", () => {
    const rows = [{ date: "2026-02-15", payment: 587, interest: 87 }];
    const s = buildLoanSchedule({ ...base, interestMethod: "flat", interestAmount: 50, manualSchedule: rows });
    expect(s.scheduleMode).toBe("manual");
    expect(s.schedule[0].interest).toBe(87);
  });
});

describe("the method travels with the loan row", () => {
  it("loanScheduleExtras reads it from both row shapes", () => {
    expect(loanScheduleExtras({ interestMethod: "flat", interestAmount: 87 })).toMatchObject({
      interestMethod: "flat",
      interestAmount: 87,
    });
    expect(loanScheduleExtras({ interest_method: "total", interest_amount: "5220" })).toMatchObject({
      interestMethod: "total",
      interestAmount: 5220,
    });
    expect(loanScheduleExtras({})).toMatchObject({ interestMethod: "rate", interestAmount: null });
  });

  it("the migration, schema-pg.ts and the calculator agree on the allowed values", () => {
    const sql = read("scripts/migrations/20261012d_loans_interest_method.sql");
    const inList = sql.match(/CHECK \(interest_method IN \(([^)]*)\)\)/);
    expect(inList).not.toBeNull();
    const fromSql = [...inList![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(fromSql).toEqual([...INTEREST_METHODS].sort());
    expect(read("src/db/schema-pg.ts")).toContain(
      "check(\"loans_interest_method_check\", sql`${t.interestMethod} IN ('rate','flat','total')`)",
    );
  });

  // A request that CHANGES the method must be validated with the new one. The
  // stored extras are spread first, so the merged fields have to come after.
  it("an update validates with the new method, not the stored one", () => {
    const rest = read("src/app/api/loans/route.ts");
    const a = rest.indexOf("...loanScheduleExtras(existing[0])");
    expect(a).toBeGreaterThan(-1);
    expect(rest.indexOf("interestMethod: merged.interestMethod", a)).toBeGreaterThan(a);
    const mcp = read("mcp-server/tools/loans.ts");
    const b = mcp.indexOf("...loanScheduleExtras(cur)");
    expect(b).toBeGreaterThan(-1);
    expect(mcp.indexOf("interestMethod: interest_method", b)).toBeGreaterThan(b);
  });

  it("no rate is suggested when the rate is not what produces the interest", () => {
    expect(read("src/lib/loans/interest-check.ts")).toContain('normalizeInterestMethod(loan.interestMethod) === "rate"');
    expect(read("src/app/(app)/loans/page.tsx")).toContain('(selectedLoan.interestMethod ?? "rate") === "rate"');
  });
});
