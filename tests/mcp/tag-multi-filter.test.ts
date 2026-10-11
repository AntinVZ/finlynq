/**
 * tags_all / tags_any / tags_none / untagged on the MCP surfaces (T2):
 * search_transactions, the bulk filter, and the cash-flow reports. DB-free:
 * a mock `execute` serves rows with real ciphertext.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

vi.mock("../../src/lib/unrealized-pnl", () => ({
  computeAllAccountsUnrealizedPnL: async () => [],
  summarizeUnrealizedPnL: () => ({ costBasis: 0, marketValue: 0, valuationGL: 0, fxGL: 0, totalGL: 0 }),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";
import { encryptField } from "../../src/lib/crypto/envelope";

type Tool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

const dek = Buffer.alloc(32, 9);
const dialect = new PgDialect();
let executed: Array<{ sql: string; params: unknown[] }> = [];
let tools: Record<string, Tool>;

// Newest first. 5: work+travel, 4: homework, 3: untagged, 2: Здоров’я, 1: Work
const TAGS: Record<number, string> = { 5: "travel,work", 4: "homework", 3: "", 2: "Здоров’я", 1: "Work" };
const ledger = [5, 4, 3, 2, 1].map((id) => ({ id, tags: encryptField(dek, TAGS[id]) }));

beforeAll(() => {
  const server = withAutoAnnotations(new McpServer({ name: "tag-multi-test", version: "0.0.0" }));
  registerPgTools(
    server,
    {
      execute: async (query: SQL) => {
        const r = dialect.sqlToQuery(query);
        executed.push({ sql: r.sql, params: r.params });
        const page = () => {
          const [size, offset] = r.params.slice(-2) as [number, number];
          return ledger.slice(offset, offset + size);
        };
        if (r.sql.includes("SELECT id, payee, note, tags FROM transactions")) {
          const rows = page().map((x) => ({ ...x, payee: null, note: null }));
          return { rows, rowCount: rows.length };
        }
        if (r.sql.includes("SELECT t.id, t.date,") && r.sql.includes("OFFSET")) {
          const rows = page().map((x) => ({ ...x, payee: null, note: null, amount: -1, currency: "CAD", date: "2026-01-01" }));
          return { rows, rowCount: rows.length };
        }
        if (r.sql.includes("SELECT t.id, t.tags")) {
          const withTags = r.sql.includes("t.tags IS NOT NULL");
          const rows = ledger.filter((x) => !withTags || TAGS[x.id] !== "");
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

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await tools[name].handler(args, {});
  const body = JSON.parse(res.content[0].text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (body.data ?? body) as any;
};

describe("search_transactions", () => {
  const ids = async (args: Record<string, unknown>) =>
    ((await call("search_transactions", { reportingCurrency: "CAD", ...args })).results as Array<{ id: number }>).map((r) => r.id);

  it("tags_all / tags_any / tags_none / untagged", async () => {
    expect(await ids({ tags_all: "work" })).toEqual([5, 1]);
    expect(await ids({ tags_all: ["work", "TRAVEL"] })).toEqual([5]);
    expect(await ids({ tags_any: "homework,здоров'я" })).toEqual([4, 2]);
    expect(await ids({ tags_none: "work" })).toEqual([4, 3, 2]);
    expect(await ids({ untagged: true })).toEqual([3]);
    expect(await ids({ untagged: "true", tags_any: "work" })).toEqual([]);
  });

  it("combines with tag_exact by AND and echoes the filter", async () => {
    const data = await call("search_transactions", { reportingCurrency: "CAD", tag_exact: "work", tags_none: "travel" });
    expect(data.results.map((r: { id: number }) => r.id)).toEqual([1]);
    expect(data.filters.tag_filter).toEqual({ none: ["travel"] });
  });

  it("untagged: false is no constraint", async () => {
    const data = await call("search_transactions", { reportingCurrency: "CAD", untagged: false });
    expect(data.filters.tag_filter).toBeUndefined();
    expect(executed.some((e) => e.sql.includes("OFFSET"))).toBe(true);
  });
});

describe("bulk filter", () => {
  it("counts as a filter on its own and matches whole tags", async () => {
    expect((await call("preview_bulk_delete", { filter: { tags_any: "work" } })).affectedCount).toBe(2);
    expect((await call("preview_bulk_delete", { filter: { untagged: true } })).affectedCount).toBe(1);
    expect((await call("preview_bulk_delete", { filter: { tags_none: "work,homework" } })).affectedCount).toBe(2);
  });

  it("works on preview_bulk_update and preview_bulk_categorize filters too", async () => {
    const upd = await call("preview_bulk_update", { filter: { tags_all: "work,travel" }, changes: { note: "x" } });
    expect(upd.affectedCount).toBe(1);
    const res = await tools.preview_bulk_categorize.handler({ filter: { tags_any: "nothing-like-this" }, category_id: 1 }, {});
    expect(res.content[0].text).toMatch(/not found|affectedCount/);
  });
});

describe.each([
  { name: "get_spending_trends", args: { period: "monthly" } },
  { name: "get_income_statement", args: { start_date: "2026-01-01", end_date: "2026-12-31" } },
])("$name", ({ name, args }) => {
  const scopeIds = () => {
    const q = executed.find((e) => e.sql.includes("GROUP BY") && e.sql.includes("FROM transactions t"))!;
    const m = q.sql.match(/ANY\(ARRAY\[([\d,]+)\]/);
    return m ? m[1].split(",").map(Number) : q.sql.includes("AND FALSE") ? [] : null;
  };
  const candidateSql = () => executed.find((e) => e.sql.includes("SELECT t.id, t.tags"))!.sql;

  it("tags_any scopes to the matching ids and skips untagged rows in SQL", async () => {
    const data = await call(name, { ...args, tags_any: "work" });
    expect(scopeIds()).toEqual([5, 1]);
    expect(candidateSql()).toContain("t.tags IS NOT NULL");
    expect(data.filters.tag_filter).toEqual({ any: ["work"] });
  });

  it("untagged / tags_none read untagged rows too", async () => {
    await call(name, { ...args, untagged: true });
    expect(scopeIds()).toEqual([3]);
    expect(candidateSql()).not.toContain("t.tags IS NOT NULL");
    executed = [];
    await call(name, { ...args, tags_none: "work" });
    expect(scopeIds()).toEqual([4, 3, 2]);
  });

  it("ANDs with the existing `tag`", async () => {
    await call(name, { ...args, tag: "work", tags_none: "travel" });
    expect(scopeIds()).toEqual([1]);
  });

  it("no tag params → no tag step, unchanged filters echo", async () => {
    const data = await call(name, args);
    expect(executed.some((e) => e.sql.includes("SELECT t.id, t.tags"))).toBe(false);
    expect(data.filters).toEqual({ business: "all", tag: null });
  });
});
