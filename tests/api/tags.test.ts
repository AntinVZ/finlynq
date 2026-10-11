/**
 * GET / POST /api/tags (Settings → Tags). DB-free: tests/helpers/tag-ledger
 * serves the tag scan and writes; FX is stubbed (1 USD = 1.5 CAD).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptField, decryptField } from "@/lib/crypto/envelope";
import { renderSql, serveTagSql, isTagCaseUpdate, type LedgerRow } from "../helpers/tag-ledger";

const dek = Buffer.alloc(32, 4);
let ledger: LedgerRow[] = [];
let statements: string[] = [];
const invalidate = vi.fn();

vi.mock("@/lib/auth/require-encryption", () => ({
  requireEncryption: vi.fn(async () => ({ ok: true, userId: "userA", dek, sessionId: "s" })),
}));
vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: (...a: unknown[]) => invalidate(...a) }));
vi.mock("@/lib/fx-service", () => ({
  getDisplayCurrency: async () => "CAD",
  getRateMap: async () => new Map([["CAD", 1], ["USD", 1.5]]),
  convertWithRateMap: (amount: number, from: string, map: Map<string, number>) => amount * (map.get(from.toUpperCase()) ?? 1),
  getRateToUsdDetailed: async () => ({ rate: 1, source: "test" }),
}));
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

import { GET, POST } from "@/app/api/tags/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const enc = (s: string) => encryptField(dek, s);
const plain = (id: number) => decryptField(dek, ledger.find((r) => r.id === id)!.tags ?? "") ?? "";
const get = async (qs = "") => parseResponse(await GET(createMockRequest(`http://localhost:3000/api/tags${qs}`)));
const post = async (body: unknown) =>
  parseResponse(await POST(createMockRequest("http://localhost:3000/api/tags", { method: "POST", body })));

beforeEach(() => {
  statements = [];
  invalidate.mockClear();
  ledger = [
    { id: 1, userId: "userA", tags: enc("Agrotrade"), date: "2026-01-01", amount: -10, currency: "CAD" },
    { id: 2, userId: "userA", tags: enc("agrotrade ,trip"), date: "2026-02-01", amount: -10, currency: "USD", isBusiness: 1 },
    { id: 3, userId: "userA", tags: enc("Agrotrade,work"), date: "2026-03-01", amount: 5, currency: "CAD" },
    { id: 4, userId: "userB", tags: enc("Agrotrade"), date: "2026-01-01" },
  ];
});

describe("GET /api/tags", () => {
  it("one entry per tag with count, dates, variants and a converted total", async () => {
    const { status, data } = await get();
    expect(status).toBe(200);
    const body = data as { tags: Array<Record<string, unknown>>; currency: string };
    expect(body.currency).toBe("CAD");
    const agro = body.tags[0];
    expect(agro).toMatchObject({
      tag: "Agrotrade",
      count: 3,
      firstDate: "2026-01-01",
      lastDate: "2026-03-01",
      hasVariants: true,
      total: -20, // -10 CAD + (-10 USD × 1.5) + 5 CAD
    });
    expect(agro.slices).toBeUndefined();
    expect(body.tags.map((t) => t.tag)).toEqual(["Agrotrade", "trip", "work"]);
  });

  it("business=true|false scopes the count", async () => {
    const biz = (await get("?business=true")).data as { tags: Array<{ tag: string; count: number }> };
    expect(biz.tags.map((t) => [t.tag, t.count])).toEqual([["agrotrade", 1], ["trip", 1]]);
    const personal = (await get("?business=false")).data as { tags: Array<{ tag: string; count: number }> };
    expect(personal.tags.find((t) => t.tag === "Agrotrade")!.count).toBe(2);
  });
});

describe("POST /api/tags", () => {
  it("dryRun reports the effect and writes nothing", async () => {
    const { data } = await post({ op: "rename", tag: "work", newName: "Agrotrade", dryRun: true });
    expect(data).toEqual({ affected: 1, targetExists: true, targetCount: 3, tooLarge: false, truncated: false });
    expect(statements.some(isTagCaseUpdate)).toBe(false);
  });

  it("rename onto an existing tag merges", async () => {
    const { data } = await post({ op: "rename", tag: "work", newName: "Agrotrade" });
    expect((data as { changed: number }).changed).toBe(1);
    expect(plain(3)).toBe("Agrotrade");
    expect(invalidate).toHaveBeenCalledWith("userA");
  });

  it("merge several into a new tag", async () => {
    await post({ op: "merge", tags: ["trip", "work"], into: "Project X" });
    expect(plain(2)).toBe("agrotrade,Project X");
    expect(plain(3)).toBe("Agrotrade,Project X");
  });

  it("delete removes the tag from transactions only, never another user's", async () => {
    const { data } = await post({ op: "delete", tags: "AGROTRADE" });
    expect((data as { changed: number }).changed).toBe(3);
    expect(plain(1)).toBe("");
    expect(plain(2)).toBe("trip");
    expect(ledger).toHaveLength(4);
    expect(decryptField(dek, ledger[3].tags!)).toBe("Agrotrade");
  });

  it("bad input → 400", async () => {
    expect((await post({ op: "rename", tag: "a", newName: "b,c" })).status).toBe(400);
    expect((await post({ op: "delete", tags: [] })).status).toBe(400);
    expect((await post({ op: "explode" })).status).toBe(400);
  });

  it("over the row limit → 409, nothing written", async () => {
    ledger = Array.from({ length: 10_001 }, (_, i) => ({ id: i + 1, userId: "userA", tags: "bulk" }));
    const { status, data } = await post({ op: "delete", tags: "bulk" });
    expect(status).toBe(409);
    expect((data as { code: string }).code).toBe("tag_op_too_large");
    expect(statements.some(isTagCaseUpdate)).toBe(false);
  });
});
