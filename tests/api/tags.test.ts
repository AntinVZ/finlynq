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
    { id: 1, userId: "userA", tags: enc("Acme"), date: "2026-01-01", amount: -10, currency: "CAD" },
    { id: 2, userId: "userA", tags: enc("acme ,trip"), date: "2026-02-01", amount: -10, currency: "USD", isBusiness: 1 },
    { id: 3, userId: "userA", tags: enc("Acme,work"), date: "2026-03-01", amount: 5, currency: "CAD" },
    { id: 4, userId: "userB", tags: enc("Acme"), date: "2026-01-01" },
  ];
});

describe("GET /api/tags", () => {
  it("one entry per tag with count, dates, variants and a converted total", async () => {
    const { status, data } = await get();
    expect(status).toBe(200);
    const body = data as { tags: Array<Record<string, unknown>>; currency: string };
    expect(body.currency).toBe("CAD");
    const ac = body.tags[0];
    expect(ac).toMatchObject({
      tag: "Acme",
      count: 3,
      firstDate: "2026-01-01",
      lastDate: "2026-03-01",
      hasVariants: true,
      total: -20, // -10 CAD + (-10 USD × 1.5) + 5 CAD
    });
    expect(ac.slices).toBeUndefined();
    expect(body.tags.map((t) => t.tag)).toEqual(["Acme", "trip", "work"]);
  });

  it("business=true|false scopes the count", async () => {
    const biz = (await get("?business=true")).data as { tags: Array<{ tag: string; count: number }> };
    expect(biz.tags.map((t) => [t.tag, t.count])).toEqual([["acme", 1], ["trip", 1]]);
    const personal = (await get("?business=false")).data as { tags: Array<{ tag: string; count: number }> };
    expect(personal.tags.find((t) => t.tag === "Acme")!.count).toBe(2);
  });
});

describe("POST /api/tags", () => {
  it("dryRun reports the effect and writes nothing", async () => {
    const { data } = await post({ op: "rename", tag: "work", newName: "Acme", dryRun: true });
    expect(data).toEqual({ affected: 1, targetExists: true, targetCount: 3, tooLarge: false, truncated: false });
    expect(statements.some(isTagCaseUpdate)).toBe(false);
  });

  it("rename onto an existing tag merges", async () => {
    const { data } = await post({ op: "rename", tag: "work", newName: "Acme" });
    expect((data as { changed: number }).changed).toBe(1);
    expect(plain(3)).toBe("Acme");
    expect(invalidate).toHaveBeenCalledWith("userA");
  });

  it("merge several into a new tag", async () => {
    await post({ op: "merge", tags: ["trip", "work"], into: "Project X" });
    expect(plain(2)).toBe("acme,Project X");
    expect(plain(3)).toBe("Acme,Project X");
  });

  it("delete removes the tag from transactions only, never another user's", async () => {
    const { data } = await post({ op: "delete", tags: "ACME" });
    expect((data as { changed: number }).changed).toBe(3);
    expect(plain(1)).toBe("");
    expect(plain(2)).toBe("trip");
    expect(ledger).toHaveLength(4);
    expect(decryptField(dek, ledger[3].tags!)).toBe("Acme");
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

describe("Settings → Tags S2: tree, business split, branch rename, normalize", () => {
  it("each tag carries business / personal counts; tree is opt-in", async () => {
    const plainGet = (await get()).data as { tags: Array<Record<string, unknown>>; tree?: unknown };
    expect(plainGet.tree).toBeUndefined();
    expect(plainGet.tags[0]).toMatchObject({ tag: "Acme", businessCount: 1, personalCount: 2 });
  });

  it("?tree=1 returns the / hierarchy with distinct-transaction rollups", async () => {
    ledger.push(
      { id: 5, userId: "userA", tags: enc("команда/Іваненко,команда/Петренко"), date: "2026-04-01", amount: -10, currency: "CAD" },
      { id: 6, userId: "userA", tags: enc("команда/Іваненко"), date: "2026-04-02", amount: -5, currency: "CAD", isBusiness: 1 },
    );
    const body = (await get("?tree=1")).data as { tree: Array<Record<string, unknown>> };
    const root = body.tree.find((n) => n.key === "команда")!;
    expect(root).toMatchObject({ count: 2, businessCount: 1, personalCount: 1, total: -15, isTag: false, childCount: 2 });
    expect(root.slices).toBeUndefined();
  });

  it("rename_prefix previews then renames the whole branch", async () => {
    ledger.push(
      { id: 5, userId: "userA", tags: enc("команда/Іваненко,trip") },
      { id: 6, userId: "userA", tags: enc("команда") },
      { id: 7, userId: "userB", tags: enc("команда") },
    );
    const dry = await post({ op: "rename_prefix", prefix: "команда", newPrefix: "друзі", dryRun: true });
    expect(dry.data).toMatchObject({ affected: 2, tagCount: 2, collisions: [] });
    expect((dry.data as Record<string, unknown>).ids).toBeUndefined();
    expect(statements.some(isTagCaseUpdate)).toBe(false);

    const { data } = await post({ op: "rename_prefix", prefix: "команда", newPrefix: "друзі" });
    expect((data as { changed: number }).changed).toBe(2);
    expect(plain(5)).toBe("друзі/Іваненко,trip");
    expect(plain(6)).toBe("друзі");
    expect(plain(7)).toBe("команда"); // other user untouched
    expect(invalidate).toHaveBeenCalledWith("userA");
  });

  it("rename_prefix into its own branch → 400", async () => {
    expect((await post({ op: "rename_prefix", prefix: "a", newPrefix: "a/b" })).status).toBe(400);
  });

  it("normalize rewrites variants to the most used spelling", async () => {
    const dry = await post({ op: "normalize", dryRun: true });
    expect(dry.data).toMatchObject({ affected: 1, tags: [{ tag: "Acme", variants: ["acme"] }] });
    const { data } = await post({ op: "normalize", tags: ["acme"] });
    expect((data as { changed: number }).changed).toBe(1);
    expect(plain(2)).toBe("Acme,trip");
  });
});
