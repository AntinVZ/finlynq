/**
 * POST /api/transactions/bulk — add_tag / remove_tag. DB-free: `db.execute`
 * is served by an in-memory ledger with real ciphertext (tests/helpers/tag-ledger).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptField, decryptField } from "@/lib/crypto/envelope";
import { renderSql, serveTagSql, isTagCaseUpdate, type LedgerRow } from "../helpers/tag-ledger";

const dek = Buffer.alloc(32, 7);
let ledger: LedgerRow[] = [];
let statements: string[] = [];
const invalidate = vi.fn();

vi.mock("@/lib/auth/require-encryption", () => ({
  requireEncryption: vi.fn(async () => ({ ok: true, userId: "userA", dek, sessionId: "s" })),
}));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "userA", dek, sessionId: "s" } })),
}));
vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: (...a: unknown[]) => invalidate(...a) }));
vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return {
    ...actual,
    db: {
      execute: async (q: import("drizzle-orm").SQL) => {
        const r = renderSql(q);
        statements.push(r.sql);
        return serveTagSql(ledger, r) ?? { rows: [], rowCount: 0 };
      },
    },
  };
});

import { POST } from "@/app/api/transactions/bulk/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const enc = (s: string) => encryptField(dek, s);
const plain = (id: number) => {
  const r = ledger.find((x) => x.id === id)!;
  return r.tags == null ? null : decryptField(dek, r.tags);
};
const post = async (body: unknown) =>
  parseResponse(await POST(createMockRequest("http://localhost:3000/api/transactions/bulk", { method: "POST", body })));

beforeEach(() => {
  statements = [];
  invalidate.mockClear();
  ledger = [
    { id: 1, userId: "userA", tags: enc("Agrotrade,travel") },
    { id: 2, userId: "userA", tags: enc("work") },
    { id: 3, userId: "userA", tags: null },
    { id: 4, userId: "userB", tags: enc("secret") },
  ];
});

describe("add_tag", () => {
  it("adds to each row, keeps existing tags, skips rows that already have it", async () => {
    const { status, data } = await post({ action: "add_tag", ids: [1, 2, 3], tag: "agrotrade " });
    expect(status).toBe(200);
    expect(plain(1)).toBe("Agrotrade,travel"); // already there (other spelling)
    expect(plain(2)).toBe("work,agrotrade");
    expect(plain(3)).toBe("agrotrade");
    expect((data as { affected: number }).affected).toBe(2);
    expect(invalidate).toHaveBeenCalledWith("userA");
  });

  it("accepts a comma list", async () => {
    await post({ action: "add_tag", ids: [2], tag: "trip, Lviv ,TRIP" });
    expect(plain(2)).toBe("work,trip,Lviv");
  });

  it("never touches another user's rows", async () => {
    const { data } = await post({ action: "add_tag", ids: [4, 2], tag: "x" });
    expect((data as { affected: number; matched: number }).affected).toBe(1);
    expect((data as { matched: number }).matched).toBe(1);
    expect(decryptField(dek, ledger[3].tags!)).toBe("secret");
    expect(ledger[3].updatedAt).toBeUndefined();
  });

  it("bumps updated_at on written rows only", async () => {
    await post({ action: "add_tag", ids: [1, 2], tag: "travel" });
    expect(ledger[0].updatedAt).toBeUndefined();
    expect(ledger[1].updatedAt).toBe("NOW");
    const upd = statements.find(isTagCaseUpdate)!;
    expect(upd).toMatch(/updated_at = NOW\(\)/);
    expect(upd).toMatch(/user_id = \$/);
  });

  it("a no-op writes nothing and doesn't invalidate the cache", async () => {
    const { data } = await post({ action: "add_tag", ids: [1], tag: "TRAVEL" });
    expect((data as { affected: number }).affected).toBe(0);
    expect(statements.some(isTagCaseUpdate)).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("remove_tag", () => {
  it("removes whole tags in any case, keeps the rest in order", async () => {
    ledger[1].tags = enc("homework,Work,x");
    const { data } = await post({ action: "remove_tag", ids: [1, 2, 3], tag: "work" });
    expect(plain(2)).toBe("homework,x");
    expect(plain(1)).toBe("Agrotrade,travel");
    expect((data as { affected: number }).affected).toBe(1);
  });

  it("removing the only tag leaves an empty list", async () => {
    await post({ action: "remove_tag", ids: [2], tag: "WORK" });
    expect(plain(2)).toBe("");
    expect(ledger[1].tags).toBe("");
  });
});

describe("validation", () => {
  it.each([
    [{ action: "add_tag", ids: [1], tag: "" }],
    [{ action: "add_tag", ids: [1], tag: " , ," }],
    [{ action: "remove_tag", ids: [1] }],
    [{ action: "add_tag", ids: [], tag: "x" }],
    [{ action: "add_tag", ids: Array.from({ length: 10_001 }, (_, i) => i + 1), tag: "x" }],
  ])("rejects %j", async (body) => {
    const { status } = await post(body);
    expect(status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it("batches large selections", async () => {
    ledger = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, userId: "userA", tags: null }));
    const { data } = await post({ action: "add_tag", ids: ledger.map((r) => r.id), tag: "bulk" });
    expect((data as { affected: number }).affected).toBe(1200);
    expect(statements.filter(isTagCaseUpdate)).toHaveLength(3);
  });
});
