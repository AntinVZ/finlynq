/**
 * MCP search_transactions — filter accuracy.
 *
 *  - payee / tags / tag_exact match in memory after decryption, so the tool
 *    pages through the SQL-filtered rows until `limit` matches are found
 *    (old behaviour: one newest-N window, older matches silently lost), and
 *    says `truncated: true` when its scan bound stops it early.
 *  - `business` (true | false | all) scopes in SQL; rows carry `is_business`.
 *  - `tag_exact` is a whole-tag match; `tags` stays a substring match.
 *
 * DB-free: the tool runs against a mock `execute` that serves a synthetic,
 * newest-first ledger with real ciphertext and honours LIMIT/OFFSET.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";
import { encryptField } from "../../src/lib/crypto/envelope";
import { scanInBatches } from "../../mcp-server/lib/scan-in-batches";

type Tool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

const dek = Buffer.alloc(32, 9);
const dialect = new PgDialect();
let executed: Array<{ sql: string; params: unknown[] }> = [];
let ledger: Array<Record<string, unknown>> = [];
let tools: Record<string, Tool>;

/** Newest-first ledger of `n` rows; `pick(i)` overrides fields of row i. */
function makeLedger(n: number, pick: (i: number) => { payee?: string; tags?: string; is_business?: number | null } = () => ({})) {
  return Array.from({ length: n }, (_, i) => {
    const o = pick(i);
    return {
      id: n - i,
      date: "2026-01-01",
      account_ct: null,
      category_ct: null,
      category_type: "E",
      currency: "UAH",
      amount: -10,
      entered_currency: "UAH",
      entered_amount: -10,
      entered_fx_rate: 1,
      payee: encryptField(dek, o.payee ?? "Coffee"),
      note: encryptField(dek, ""),
      tags: encryptField(dek, o.tags ?? ""),
      portfolio_holding_id: null,
      quantity: null,
      is_business: o.is_business === undefined ? 0 : o.is_business,
      created_at: null,
      updated_at: null,
      source: "manual",
    };
  });
}

const isSearch = (s: string) => s.includes("FROM transactions t") && s.includes("t.entered_fx_rate");

beforeAll(() => {
  const server = withAutoAnnotations(new McpServer({ name: "search-filter-test", version: "0.0.0" }));
  registerPgTools(
    server,
    {
      execute: async (query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        executed.push({ sql: rendered.sql, params: rendered.params });
        if (isSearch(rendered.sql)) {
          // LIMIT $n OFFSET $m are the last two params.
          const [size, offset] = rendered.params.slice(-2) as [number, number];
          const rows = ledger.slice(offset, offset + size);
          return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    "user-1",
    dek,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools = (server as any)._registeredTools as Record<string, Tool>;
});

beforeEach(() => {
  executed = [];
});

const run = async (args: Record<string, unknown>) => {
  const res = await tools.search_transactions.handler({ reportingCurrency: "UAH", ...args }, {});
  const body = JSON.parse(res.content[0].text);
  return body.data ?? body;
};
const searchQueries = () => executed.filter((e) => isSearch(e.sql));

describe("search_transactions payee/tag scan", () => {
  it("finds a match older than the old max(limit*10, 500) window", async () => {
    // 1200 rows, the only "Landlord" payee is row 1100 — beyond the old
    // 500-row window for limit 50.
    ledger = makeLedger(1200, (i) => (i === 1100 ? { payee: "Landlord LLC" } : {}));
    const out = await run({ payee: "landlord" });
    expect(out.count).toBe(1);
    expect(out.results[0].id).toBe(1200 - 1100);
    expect(out.results[0].payee).toBe("Landlord LLC");
    expect(out.truncated).toBe(false);
    expect(searchQueries().length).toBeGreaterThan(1);
  });

  it("stops paging once `limit` matches are collected", async () => {
    ledger = makeLedger(3000, (i) => (i % 2 === 0 ? { payee: "Silpo" } : {}));
    const out = await run({ payee: "silpo", limit: 5 });
    expect(out.count).toBe(5);
    expect(searchQueries()).toHaveLength(1);
  });

  it("pages in a stable order (date, then id)", async () => {
    ledger = makeLedger(10);
    await run({ payee: "coffee" });
    expect(searchQueries()[0].sql).toContain("ORDER BY t.date DESC, t.id DESC");
  });

  it("without an in-memory filter reads exactly `limit` rows once", async () => {
    ledger = makeLedger(100);
    const out = await run({ limit: 7 });
    expect(out.count).toBe(7);
    expect(searchQueries()).toHaveLength(1);
    expect(searchQueries()[0].params.slice(-2)).toEqual([7, 0]);
    expect(out.truncated).toBe(false);
  });

  it("reports truncated: true when the scan bound is hit with rows left", async () => {
    ledger = makeLedger(20_050); // no match anywhere, more rows than the bound
    const out = await run({ payee: "nobody" });
    expect(out.count).toBe(0);
    expect(out.truncated).toBe(true);
    expect(out.note).toMatch(/older matches may exist/);
  });
});

describe("search_transactions tag_exact vs tags", () => {
  beforeEach(() => {
    ledger = makeLedger(3, (i) => ({ tags: ["travel,work", "homework", "Work"][i] }));
  });

  it("tags stays a substring match (backward compatible)", async () => {
    const out = await run({ tags: "work" });
    expect(out.results.map((r: { id: number }) => r.id)).toEqual([3, 2, 1]);
  });

  it("tag_exact matches whole tags only, case-insensitively", async () => {
    const out = await run({ tag_exact: " work " });
    expect(out.results.map((r: { id: number }) => r.id)).toEqual([3, 1]);
    expect(out.filters.tag_exact).toBe("work");
  });

  it("blank tag_exact is ignored", async () => {
    const out = await run({ tag_exact: "  " });
    expect(out.count).toBe(3);
    expect(out.filters.tag_exact).toBeNull();
  });
});

describe("search_transactions business", () => {
  it("adds no condition by default and rows carry is_business", async () => {
    ledger = makeLedger(3, (i) => ({ is_business: [1, 0, null][i] }));
    const out = await run({});
    expect(searchQueries()[0].sql).not.toContain("is_business =");
    expect(searchQueries()[0].sql).not.toContain("COALESCE(t.is_business");
    expect(out.results.map((r: { is_business: boolean }) => r.is_business)).toEqual([true, false, false]);
    expect(out.filters.business).toBe("all");
  });

  it("business: true / \"true\" scopes to is_business = 1", async () => {
    ledger = makeLedger(1);
    for (const business of [true, "true"]) {
      executed = [];
      const out = await run({ business });
      expect(searchQueries()[0].sql).toContain("t.is_business = 1");
      expect(out.filters.business).toBe("business");
    }
  });

  it("business: false scopes to personal (NULL counts as personal)", async () => {
    ledger = makeLedger(1);
    const out = await run({ business: "false" });
    expect(searchQueries()[0].sql).toContain("COALESCE(t.is_business, 0) = 0");
    expect(out.filters.business).toBe("personal");
  });

  it("business: all applies no condition", async () => {
    ledger = makeLedger(1);
    await run({ business: "all" });
    expect(searchQueries()[0].sql).not.toContain("COALESCE(t.is_business");
  });
});

describe("scanInBatches", () => {
  const source = (n: number) => {
    const data = Array.from({ length: n }, (_, i) => i);
    const calls: Array<[number, number]> = [];
    return {
      calls,
      fetchPage: async (offset: number, size: number) => {
        calls.push([offset, size]);
        return data.slice(offset, offset + size);
      },
    };
  };

  it("walks pages until the rows run out", async () => {
    const s = source(25);
    const r = await scanInBatches({ fetchPage: s.fetchPage, match: (x) => x % 10 === 9, limit: 10, batchSize: 10, maxScan: 1000 });
    expect(r.rows).toEqual([9, 19]);
    expect(r.scanned).toBe(25);
    expect(r.truncated).toBe(false);
    expect(s.calls).toEqual([[0, 10], [10, 10], [20, 10]]);
  });

  it("is not truncated when the bound lands exactly at the end", async () => {
    const s = source(20);
    const r = await scanInBatches({ fetchPage: s.fetchPage, match: () => false, limit: 5, batchSize: 10, maxScan: 20 });
    expect(r.truncated).toBe(false);
  });

  it("is truncated when the bound leaves rows unread", async () => {
    const s = source(21);
    const r = await scanInBatches({ fetchPage: s.fetchPage, match: () => false, limit: 5, batchSize: 10, maxScan: 20 });
    expect(r.truncated).toBe(true);
    expect(r.scanned).toBe(20);
  });

  it("limit 0 reads nothing", async () => {
    const s = source(5);
    const r = await scanInBatches({ fetchPage: s.fetchPage, match: () => true, limit: 0, batchSize: 10, maxScan: 20 });
    expect(r.rows).toEqual([]);
    expect(s.calls).toEqual([]);
  });
});
