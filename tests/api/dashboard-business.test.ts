/**
 * GET /api/dashboard?business=true|false|all — route side. The scope reaches
 * the three FLOW queries only; balances and net worth over time are called
 * exactly as before. The response echoes the applied scope as `business`.
 * (tests/api/dashboard.test.ts is quarantined, so this file mocks every
 * dependency the route touches.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: "u1", method: "passphrase" as const, mfaVerified: false, dek: null, sessionId: "s" },
  })),
}));

const q = vi.hoisted(() => ({
  getAccountBalances: vi.fn(async () => []),
  getIncomeVsExpenses: vi.fn(async () => []),
  getIncomeExpenseByCategory: vi.fn(async () => []),
  getSpendingByCategoryWithReporting: vi.fn(async () => []),
  getNetWorthOverTime: vi.fn(async () => []),
}));
vi.mock("@/lib/queries", () => q);
vi.mock("@/lib/fx-service", () => ({
  getRateMap: async () => new Map([["CAD", 1]]),
  convertWithRateMap: (n: number) => n,
  getDisplayCurrency: async () => "CAD",
}));
vi.mock("@/lib/fx/reporting-amount", () => ({
  selfHealReportingAmounts: async () => {},
  convertReportingSlice: () => 0,
}));
vi.mock("@/lib/holdings-value", () => ({
  getHoldingsValueByAccount: async () => new Map(),
  verifyHoldingDecryptHealth: async () => ({ failed: 0, total: 0 }),
}));
vi.mock("@/lib/accounts/investment-balance-overlay", () => ({
  applyInvestmentMarketOverlay: async () => ({ rows: [] }),
}));

import { GET } from "@/app/api/dashboard/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const get = async (qs: string) =>
  parseResponse(await GET(createMockRequest(`http://localhost:3000/api/dashboard${qs}`)));

describe("GET /api/dashboard business", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["?business=true", "business"],
    ["?business=false", "personal"],
    ["?business=all", "all"],
    ["", "all"],
    ["?business=nope", "all"],
  ])("%j → flow queries get %s", async (qs, expected) => {
    const { status, data } = await get(qs);
    expect(status).toBe(200);
    expect((data as { business: string }).business).toBe(expected);
    for (const fn of [q.getIncomeVsExpenses, q.getIncomeExpenseByCategory, q.getSpendingByCategoryWithReporting]) {
      expect(fn).toHaveBeenCalledWith("u1", expect.any(String), expect.any(String), expected);
    }
  });

  it("balances and net worth are never scoped", async () => {
    await get("?business=true");
    expect(q.getAccountBalances).toHaveBeenCalledWith("u1", { includeArchived: true });
    expect(q.getNetWorthOverTime).toHaveBeenCalledWith("u1");
  });
});
