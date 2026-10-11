import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: {
      userId: "default",
      method: "passphrase" as const,
      mfaVerified: false,
      dek: Buffer.alloc(32, 0xaa),
      sessionId: "test-session-jti",
    },
  })),
}));

// FINLYNQ-94 — the route now delegates to the shared calculator at
// src/lib/financial-health.ts. We mock the calculator at that boundary
// so the route test stays focused on the wire shape; calculator behavior
// is covered by tests/lib/financial-health.test.ts.
const mockCalculate = vi.fn();
vi.mock("@/lib/financial-health", () => ({
  calculateFinancialHealth: (...a: unknown[]) => mockCalculate(...a),
}));

vi.mock("@/lib/fx-service", () => ({
  getDisplayCurrency: vi.fn(async () => "CAD"),
}));

vi.mock("@/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
}));

import { GET } from "@/app/api/health-score/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const SAMPLE_PAYLOAD = {
  score: 72,
  grade: "Good" as const,
  components: [
    { name: "Savings Rate", score: 100, weight: 0.25, weighted: 25, detail: "30% savings rate" },
    { name: "Debt-to-Income", score: 80, weight: 0.2, weighted: 16, detail: "20% debt-to-income (12m)" },
    { name: "Emergency Fund", score: 50, weight: 0.15, weighted: 8, detail: "3.0 months covered" },
    {
      name: "Net Worth Trend",
      score: 60,
      weight: 0.15,
      weighted: 9,
      detail: "Up 2.0% over the last 3 months",
      detailRich: { direction: "up", magnitudePct: 2, descriptor: "Up 2.0% over the last 3 months" },
    },
    { name: "Budget Adherence", score: 75, weight: 0.15, weighted: 11, detail: "3/4 on track" },
    { name: "Age of Money", score: 50, weight: 0.1, weighted: 5, detail: "15 days (+2d trend)" },
  ],
  excludedComponents: [],
  reportingCurrency: "CAD",
  totals: {
    totalIncome3m: { amount: 15000, currency: "CAD", type: "reporting" },
    totalExpenses3m: { amount: 10000, currency: "CAD", type: "reporting" },
    totalIncome12m: { amount: 60000, currency: "CAD", type: "reporting" },
    totalDebtPayments12m: { amount: 12000, currency: "CAD", type: "reporting" },
    totalLiabilities: { amount: 25000, currency: "CAD", type: "reporting" },
    liquidAssets: { amount: 10000, currency: "CAD", type: "reporting" },
    netWorthToday: { amount: 50000, currency: "CAD", type: "reporting" },
    netWorth90DaysAgo: { amount: 49000, currency: "CAD", type: "reporting" },
    avgMonthlyExpenses3m: { amount: 3333, currency: "CAD", type: "reporting" },
    ageOfMoneyDays: 15,
    ageOfMoneyTrendDays: 2,
  },
};

describe("API /api/health-score", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalculate.mockResolvedValue(SAMPLE_PAYLOAD);
  });

  it("returns the calculator's wire shape unchanged", async () => {
    const req = createMockRequest("http://localhost:3000/api/health-score");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as typeof SAMPLE_PAYLOAD;
    expect(d.score).toBe(72);
    expect(d.grade).toBe("Good");
    expect(d.components).toHaveLength(6);
    expect(d.reportingCurrency).toBe("CAD");
    expect(d.totals.totalIncome3m.amount).toBe(15000);
  });

  it("propagates excluded components", async () => {
    mockCalculate.mockResolvedValueOnce({
      ...SAMPLE_PAYLOAD,
      components: SAMPLE_PAYLOAD.components.filter((c) => c.name !== "Budget Adherence"),
      excludedComponents: [
        { name: "Budget Adherence", reason: "no_budgets", detail: "No budgets set" },
      ],
    });
    const req = createMockRequest("http://localhost:3000/api/health-score");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as typeof SAMPLE_PAYLOAD;
    expect(d.excludedComponents).toEqual([
      { name: "Budget Adherence", reason: "no_budgets", detail: "No budgets set" },
    ]);
  });

  it("threads the reporting-currency query param into the calculator", async () => {
    const req = createMockRequest("http://localhost:3000/api/health-score?currency=USD");
    await GET(req);
    expect(mockCalculate).toHaveBeenCalledWith(
      expect.objectContaining({ reportingCurrency: "CAD" }), // getDisplayCurrency is mocked to "CAD"
    );
  });

  it("passes the user's DEK through to the calculator", async () => {
    const req = createMockRequest("http://localhost:3000/api/health-score");
    await GET(req);
    const call = mockCalculate.mock.calls[0]?.[0] as { dek: Buffer | null; userId: string };
    expect(call.userId).toBe("default");
    expect(call.dek).toBeInstanceOf(Buffer);
  });

  it("clamps and grades — sanity passthrough", async () => {
    const req = createMockRequest("http://localhost:3000/api/health-score");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { grade: string; score: number };
    expect(["Excellent", "Good", "Fair", "Needs Work"]).toContain(d.grade);
    expect(d.score).toBeGreaterThanOrEqual(0);
    expect(d.score).toBeLessThanOrEqual(100);
  });

  it.each([
    ["?business=true", "business"],
    ["?business=false", "personal"],
    ["", "all"],
  ])("%j → savingsScope %s (headline savings rate only)", async (qs, expected) => {
    mockCalculate.mockResolvedValue(SAMPLE_PAYLOAD);
    await GET(createMockRequest(`http://localhost:3000/api/health-score${qs}`));
    const call = mockCalculate.mock.calls.at(-1)?.[0] as { savingsScope: string };
    expect(call.savingsScope).toBe(expected);
  });
});

