/**
 * GET /api/transactions?business=true|false|all — route side. The value is
 * parsed like the reports (default all; unknown = all) and handed to
 * getTransactions AND getTransactionCount through TxSortFilter, so it scopes
 * the list, the post-decrypt window and the total. The SQL condition itself is
 * covered in tests/transactions-business-filter.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: null, sessionId: "s" },
  })),
}));

const mockGetTransactions = vi.fn();
const mockGetTransactionCount = vi.fn();
vi.mock("@/lib/queries", () => ({
  getTransactions: (...args: unknown[]) => mockGetTransactions(...args),
  getTransactionCount: (...args: unknown[]) => mockGetTransactionCount(...args),
  createTransaction: vi.fn(),
  updateTransaction: vi.fn(),
  getAccountById: vi.fn(),
}));
vi.mock("@/lib/securities/flag", () => ({ securitiesReadEnabledForUser: async () => false }));

import { GET } from "@/app/api/transactions/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const get = async (qs: string) => {
  const res = await GET(createMockRequest(`http://localhost:3000/api/transactions${qs}`));
  return parseResponse(res);
};
const listFilters = () => mockGetTransactions.mock.calls[0][1] as Record<string, unknown>;

describe("GET /api/transactions business", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTransactions.mockReturnValue([]);
    mockGetTransactionCount.mockReturnValue(0);
  });

  it("business=true scopes the list and the count", async () => {
    await get("?business=true");
    expect(listFilters().business).toBe("business");
    expect(mockGetTransactionCount).toHaveBeenCalledWith("default", expect.objectContaining({ business: "business" }));
  });

  it("business=false scopes to personal", async () => {
    await get("?business=false");
    expect(listFilters().business).toBe("personal");
  });

  it.each(["", "?business=all", "?business=maybe", "?business="])("%j → no business filter", async (qs) => {
    await get(qs);
    expect(listFilters().business).toBeUndefined();
  });

  it("combines with search / filter_note / tag on the post-decrypt path", async () => {
    mockGetTransactions.mockReturnValue([
      { id: 1, payee: "Rent Co", note: "may", tags: "home" },
      { id: 2, payee: "Cafe", note: "rent", tags: "food" },
      { id: 3, payee: "Rent Co", note: "june", tags: "home" },
    ]);
    const { status, data } = await get("?business=true&search=rent&filter_note=may&tag=home");
    expect(status).toBe(200);
    expect(listFilters()).toEqual(expect.objectContaining({ business: "business", limit: 1000, offset: 0 }));
    const body = data as { data: Array<{ id: number }>; total: number };
    expect(body.data.map((r) => r.id)).toEqual([1]);
    expect(body.total).toBe(1);
  });
});
