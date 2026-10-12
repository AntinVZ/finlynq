/**
 * Loan interest entries (2026-10-12): a payment stays a plain transfer into the
 * loan account, and the interest is a separate expense entry on that account.
 *
 * "Is this period booked" is read from the ledger, so interest typed in by hand
 * or recorded by an assistant counts exactly like a generated entry.
 *
 * The pure half (matching ledger entries to periods, which periods are due,
 * the sign of the entry) is tested directly. The server half is pinned
 * statically, because the properties that matter are structural: one
 * chokepoint shared by REST and MCP, an atomic write, a re-check under a lock,
 * and no network call while the transaction is open.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dueUnpostedInterest,
  interestLedgerAmount,
  isPostableInterest,
  matchInterestToSchedule,
} from "@/lib/loans/interest-plan";
import { buildLoanSchedule } from "@/lib/loan-calculator";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Strip comments so a rule quoted in prose can't satisfy a code assertion. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const schedule = [
  { period: 1, date: "2026-08-01", interest: 90 },
  { period: 2, date: "2026-09-01", interest: 88.5 },
  { period: 3, date: "2026-10-01", interest: 87 },
  { period: 4, date: "2026-11-01", interest: 85.4 },
];
const tx = (transactionId: number, date: string, amount: number) => ({ transactionId, date, amount });

describe("matchInterestToSchedule", () => {
  it("credits an entry dated on the payment date to that period", () => {
    const { booked } = matchInterestToSchedule(schedule, [tx(1, "2026-09-01", -88.5)]);
    expect(booked.get("2026-09-01")).toEqual({ amount: 88.5, transactionIds: [1] });
    expect(booked.size).toBe(1);
  });

  // The reason matching is by nearest date: a lender posts interest a few days
  // either side of the payment, and a hand-entered one carries whatever date
  // the user typed.
  it("credits an entry a few days off to the nearest payment date", () => {
    const { booked } = matchInterestToSchedule(schedule, [
      tx(1, "2026-08-29", -88.5),
      tx(2, "2026-10-04", -87),
    ]);
    expect([...booked.keys()].sort()).toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("gives a tie to the earlier period", () => {
    const two = [
      { period: 1, date: "2026-08-01", interest: 90 },
      { period: 2, date: "2026-08-11", interest: 90 },
    ];
    const { booked } = matchInterestToSchedule(two, [tx(1, "2026-08-06", -90)]);
    expect([...booked.keys()]).toEqual(["2026-08-01"]);
  });

  it("sums several entries in one period and keeps every transaction id", () => {
    const { booked } = matchInterestToSchedule(schedule, [
      tx(1, "2026-09-01", -80),
      tx(2, "2026-09-03", -8.5),
    ]);
    expect(booked.get("2026-09-01")).toEqual({ amount: 88.5, transactionIds: [1, 2] });
  });

  it("nets a refund against the charge", () => {
    const { booked } = matchInterestToSchedule(schedule, [
      tx(1, "2026-09-01", -100),
      tx(2, "2026-09-02", 11.5),
    ]);
    expect(booked.get("2026-09-01")?.amount).toBe(88.5);
  });

  it("a charge that was fully reversed leaves the period unbooked (still due)", () => {
    const { booked } = matchInterestToSchedule(schedule, [
      tx(1, "2026-09-01", -88.5),
      tx(2, "2026-09-01", 88.5),
    ]);
    expect(booked.has("2026-09-01")).toBe(false);
    const due = dueUnpostedInterest(schedule, new Set(booked.keys()), "2026-10-12");
    expect(due.map((r) => r.date)).toContain("2026-09-01");
  });

  it("leaves an entry far outside the schedule's dates unmatched", () => {
    const { booked, unmatched } = matchInterestToSchedule(schedule, [
      tx(1, "2025-01-15", -50),
      tx(2, "2027-06-01", -50),
    ]);
    expect(booked.size).toBe(0);
    expect(unmatched.map((t) => t.transactionId)).toEqual([1, 2]);
  });

  it("with no schedule, everything is unmatched", () => {
    const { booked, unmatched } = matchInterestToSchedule([], [tx(1, "2026-09-01", -5)]);
    expect(booked.size).toBe(0);
    expect(unmatched).toHaveLength(1);
  });

  // The user-facing promise: interest entered by hand is not generated again.
  it("a hand-entered charge takes its period off the due list", () => {
    const { booked } = matchInterestToSchedule(schedule, [tx(7, "2026-08-30", -87)]);
    const due = dueUnpostedInterest(schedule, new Set(booked.keys()), "2026-10-12");
    expect(due.map((r) => r.date)).toEqual(["2026-08-01", "2026-10-01"]);
  });
});

describe("dueUnpostedInterest", () => {
  it("returns every payment date that has arrived and is not booked", () => {
    const due = dueUnpostedInterest(schedule, new Set(), "2026-10-12");
    expect(due.map((r) => r.date)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });

  it("leaves out periods that already have interest booked", () => {
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
  const lib = code("src/lib/loans/interest-entries.ts");

  it("REST and MCP both go through postLoanInterest", () => {
    expect(code("src/app/api/loans/interest/route.ts")).toContain("postLoanInterest(");
    expect(code("mcp-server/tools/loans.ts")).toContain("postLoanInterest(");
  });

  it("neither surface creates the transaction itself", () => {
    for (const p of ["src/app/api/loans/interest/route.ts", "mcp-server/tools/loans.ts"]) {
      expect(code(p)).not.toContain("createTransaction(");
    }
  });

  it("the web panel, the server and the MCP tool decide 'booked' with the same matcher", () => {
    for (const p of [
      "src/app/(app)/loans/_components/interest-entries.tsx",
      "src/lib/loans/interest-entries.ts",
      "mcp-server/tools/loans.ts",
    ]) {
      expect(code(p), p).toContain("matchInterestToSchedule(");
    }
  });

  it("writes through the domain layer, inside one DB transaction", () => {
    const start = lib.indexOf("withDbTransaction(");
    expect(start).toBeGreaterThan(-1);
    expect(lib.indexOf("createTransaction(", start)).toBeGreaterThan(start);
  });

  // Two requests racing for one period both pass the first check. The second
  // look has to happen under the loan row lock, before anything is created.
  it("locks the loan and re-checks the ledger before creating anything", () => {
    const start = lib.indexOf("withDbTransaction(");
    const lock = lib.indexOf("FOR UPDATE", start);
    const recheck = lib.indexOf("refuseIfBooked()", lock);
    const create = lib.indexOf("createTransaction(", start);
    expect(lock).toBeGreaterThan(start);
    expect(recheck).toBeGreaterThan(lock);
    expect(create).toBeGreaterThan(recheck);
  });

  // The FX lookup can reach the network; it must be resolved before a pool
  // client is held, never inside the transaction block.
  it("resolves reporting amounts before the transaction opens", () => {
    expect(lib.indexOf("computeReportingFields(")).toBeGreaterThan(-1);
    expect(lib.indexOf("computeReportingFields(")).toBeLessThan(lib.indexOf("withDbTransaction("));
  });

  // Found on dev: the first entry on an empty linked account flips the loan
  // from its projected balance to the account's, so a 12,000 loan read as 60.
  it("refuses to make interest the first entry on an empty loan account", () => {
    const start = lib.indexOf("withDbTransaction(");
    const guard = lib.indexOf("activity?.n");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(start);
    expect(lib).toContain("Set its opening balance first");
  });

  it("refuses before writing: unlinked loan, investment account, off-schedule date", () => {
    const start = lib.indexOf("withDbTransaction(");
    for (const guard of ["loan.accountId == null", "account.isInvestment", "scheduleDates.has("]) {
      const at = lib.indexOf(guard);
      expect(at, guard).toBeGreaterThan(-1);
      expect(at, guard).toBeLessThan(start);
    }
  });

  it("does not count a transfer leg filed under the interest category", () => {
    expect(code("src/lib/loans/interest-check.ts")).toContain("isNull(schema.transactions.linkId)");
    // ...and the writer reads the ledger through that one query, not its own.
    expect(lib).toContain("loadInterestTransactions(");
  });

  it("invalidates the MCP transaction cache and stamps the snapshot dirty marker", () => {
    expect(lib).toContain("invalidateUserTxCache(userId)");
    expect(lib).toContain("markCashSnapshotsDirty(");
  });

  it("the migration and schema-pg.ts agree on the column and its SET NULL", () => {
    const sql = read("scripts/migrations/20261012b_loans_interest_category.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS interest_category_id INTEGER");
    expect(sql).toContain("REFERENCES categories(id) ON DELETE SET NULL");
    expect(read("src/db/schema-pg.ts")).toContain(
      'integer("interest_category_id").references(() => categories.id, { onDelete: "set null" })',
    );
  });

  // The first cut tracked postings in their own table. It is gone; nothing may
  // read or write it again.
  it("nothing references the retired tracking table", () => {
    for (const p of [
      "src/db/schema-pg.ts",
      "src/lib/loans/interest-entries.ts",
      "src/app/api/loans/interest/route.ts",
      "mcp-server/tools/loans.ts",
    ]) {
      expect(code(p), p).not.toMatch(/loan_interest_postings|loanInterestPostings/);
    }
  });
});
