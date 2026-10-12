/**
 * Loan interest entries (2026-10-12): a payment stays a plain transfer into the
 * loan account, and the interest is a separate expense entry on that account.
 *
 * The pure half (which periods are due, the sign of the entry) is tested
 * directly. The server half is pinned statically, because the properties that
 * matter are structural: one chokepoint shared by REST and MCP, the write is
 * atomic, and no network call happens while the transaction is open.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dueUnpostedInterest,
  interestLedgerAmount,
  isPostableInterest,
} from "@/lib/loans/interest-plan";
import { buildLoanSchedule } from "@/lib/loan-calculator";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Strip comments so a rule quoted in prose can't satisfy a code assertion. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("dueUnpostedInterest", () => {
  const schedule = [
    { period: 1, date: "2026-08-01", interest: 90 },
    { period: 2, date: "2026-09-01", interest: 88.5 },
    { period: 3, date: "2026-10-01", interest: 87 },
    { period: 4, date: "2026-11-01", interest: 85.4 },
  ];

  it("returns every payment date that has arrived and is not posted", () => {
    const due = dueUnpostedInterest(schedule, new Set(), "2026-10-12");
    expect(due.map((r) => r.date)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });

  it("leaves out periods that already have an entry", () => {
    const due = dueUnpostedInterest(schedule, new Set(["2026-08-01", "2026-10-01"]), "2026-10-12");
    expect(due.map((r) => r.date)).toEqual(["2026-09-01"]);
  });

  it("treats a payment due today as due, and tomorrow's as not yet", () => {
    expect(dueUnpostedInterest(schedule, new Set(), "2026-11-01").map((r) => r.period)).toContain(4);
    expect(dueUnpostedInterest(schedule, new Set(), "2026-10-31").map((r) => r.period)).not.toContain(4);
  });

  it("skips periods whose interest rounds to nothing (0% loans)", () => {
    const zero = [{ period: 1, date: "2026-01-01", interest: 0 }];
    expect(dueUnpostedInterest(zero, new Set(), "2026-10-12")).toEqual([]);
  });

  it("works on a real schedule row shape", () => {
    const { schedule: real } = buildLoanSchedule({
      principal: 30000,
      annualRate: 3.48,
      termMonths: 60,
      startDate: "2026-01-15",
    });
    const due = dueUnpostedInterest(real, new Set([real[0].date]), real[2].date);
    expect(due.map((r) => r.period)).toEqual([2, 3]);
  });
});

describe("interestLedgerAmount", () => {
  it("is negative: interest adds to what a liability account owes", () => {
    expect(interestLedgerAmount(87)).toBe(-87);
  });

  it("stays negative whatever sign the caller passed", () => {
    expect(interestLedgerAmount(-87)).toBe(-87);
  });

  it("rounds to cents", () => {
    expect(interestLedgerAmount(86.666)).toBe(-86.67);
  });

  // The whole point of the model: a 587 payment against 87 of interest takes
  // the balance down by 500, with the payment left as one un-split transfer.
  it("payment transfer plus interest entry moves the balance by the principal", () => {
    const owedBefore = -10000;
    const after = owedBefore + interestLedgerAmount(87) + 587;
    expect(after).toBe(-9500);
  });
});

describe("isPostableInterest", () => {
  it("accepts a cent or more", () => {
    expect(isPostableInterest(0.01)).toBe(true);
    expect(isPostableInterest(87)).toBe(true);
  });

  it("rejects zero, sub-cent, NaN and non-numbers", () => {
    for (const v of [0, 0.004, NaN, Infinity, "87", null, undefined]) {
      expect(isPostableInterest(v)).toBe(false);
    }
  });
});

describe("posting chokepoint (static wiring)", () => {
  const lib = code("src/lib/loans/interest-postings.ts");

  it("REST and MCP both go through postLoanInterest", () => {
    expect(code("src/app/api/loans/interest/route.ts")).toContain("postLoanInterest(");
    expect(code("mcp-server/tools/loans.ts")).toContain("postLoanInterest(");
  });

  it("neither surface inserts the posting row or the transaction itself", () => {
    for (const p of ["src/app/api/loans/interest/route.ts", "mcp-server/tools/loans.ts"]) {
      expect(code(p)).not.toMatch(/loan_interest_postings|loanInterestPostings\)/);
      expect(code(p)).not.toContain("createTransaction(");
    }
  });

  it("writes the transaction through the domain layer, inside one DB transaction", () => {
    const tx = lib.indexOf("withDbTransaction(");
    expect(tx).toBeGreaterThan(-1);
    expect(lib.indexOf("createTransaction(", tx)).toBeGreaterThan(tx);
    expect(lib.indexOf("insert(schema.loanInterestPostings)", tx)).toBeGreaterThan(tx);
  });

  // The FX lookup can reach the network; it must be resolved before a pool
  // client is held, never inside the transaction block.
  it("resolves reporting amounts before the transaction opens", () => {
    expect(lib.indexOf("computeReportingFields(")).toBeGreaterThan(-1);
    expect(lib.indexOf("computeReportingFields(")).toBeLessThan(lib.indexOf("withDbTransaction("));
  });

  it("refuses before writing: unlinked loan, investment account, already posted", () => {
    const tx = lib.indexOf("withDbTransaction(");
    for (const guard of ["loan.accountId == null", "account.isInvestment", "already.length"]) {
      const at = lib.indexOf(guard);
      expect(at, guard).toBeGreaterThan(-1);
      expect(at, guard).toBeLessThan(tx);
    }
  });

  it("invalidates the MCP transaction cache and stamps the snapshot dirty marker", () => {
    expect(lib).toContain("invalidateUserTxCache(userId)");
    expect(lib).toContain("markCashSnapshotsDirty(");
  });

  it("the migration and schema-pg.ts declare the same unique key", () => {
    const sql = read("scripts/migrations/20261012_loan_interest_postings.sql");
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS loan_interest_postings_loan_period_uniq\s+ON loan_interest_postings \(loan_id, period_date\)/);
    expect(read("src/db/schema-pg.ts")).toContain(
      'uniqueIndex("loan_interest_postings_loan_period_uniq").on(t.loanId, t.periodDate)',
    );
  });
});
