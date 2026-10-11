/**
 * GET /api/transactions — tags_all / tags_any / tags_none / untagged (T2).
 * Whole tags after decryption, ANDed with `tag` and the other filters, and on
 * the post-decrypt (1000-row window) path like `tag`.
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

const ids = async (qs: string) => {
  const { data } = await parseResponse(await GET(createMockRequest(`http://localhost:3000/api/transactions${qs}`)));
  return (data as { data: Array<{ id: number }> }).data.map((r) => r.id);
};

describe("GET /api/transactions multi-tag filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTransactions.mockReturnValue([
      { id: 1, payee: "a", note: "", tags: "travel,work" },
      { id: 2, payee: "b", note: "", tags: "homework" },
      { id: 3, payee: "c", note: "", tags: "" },
      { id: 4, payee: "d", note: "", tags: null },
      { id: 5, payee: "e", note: "", tags: "Здоров’я, WORK" },
    ]);
    mockGetTransactionCount.mockReturnValue(5);
  });

  it("tags_all", async () => {
    expect(await ids("?tags_all=work")).toEqual([1, 5]);
    expect(await ids("?tags_all=work,travel")).toEqual([1]);
    expect(await ids("?tags_all=work&tags_all=здоров'я")).toEqual([5]);
  });

  it("tags_any", async () => {
    expect(await ids("?tags_any=homework,travel")).toEqual([1, 2]);
  });

  it("tags_none (whole tags: work ≠ homework)", async () => {
    expect(await ids("?tags_none=work")).toEqual([2, 3, 4]);
  });

  it("untagged=true; untagged=false is no filter", async () => {
    expect(await ids("?untagged=true")).toEqual([3, 4]);
    expect(await ids("?untagged=false")).toEqual([1, 2, 3, 4, 5]);
    // Not a post-decrypt filter → normal SQL paging.
    expect(mockGetTransactions.mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ limit: 100 }));
  });

  it("ANDs with tag and search, on the post-decrypt window", async () => {
    expect(await ids("?tag=work&tags_none=travel&search=e")).toEqual([5]);
    expect(mockGetTransactions.mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ limit: 1000, offset: 0 }));
  });
});
