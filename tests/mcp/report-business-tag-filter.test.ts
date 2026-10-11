/**
 * MCP get_spending_trends / get_income_statement — optional `business`
 * (true | false | all) and `tag` (exact) scoping.
 *
 * DB-free: the tools run against a mock `execute` that records the rendered
 * SQL. Tags are encrypted per row, so the tag filter is a two-step read (the
 * candidate rows' tags are decrypted in memory, then the report is restricted
 * to the matching ids); the mock serves real ciphertext for that step.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// The income statement's unrealized block reads holdings through the global db;
// it is not scoped by business/tag and is out of scope here.
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
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

const dek = Buffer.alloc(32, 7);
const dialect = new PgDialect();
let executed: Array<{ sql: string; params: unknown[] }> = [];
let tools: Record<string, Tool>;

// Candidate rows for the tag step: 11 and 13 carry `work`; 12 only `homework`.
const taggedRows = () => [
  { id: 11, tags: encryptField(dek, "travel,work") },
  { id: 12, tags: encryptField(dek, "homework") },
  { id: 13, tags: encryptField(dek, "Work") },
];
let candidateRows: Array<{ id: number; tags: string | null }> = [];

beforeAll(() => {
  const server = withAutoAnnotations(new McpServer({ name: "report-filter-test", version: "0.0.0" }));
  registerPgTools(
    server,
    {
      execute: async (query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        executed.push({ sql: rendered.sql, params: rendered.params });
        if (rendered.sql.includes("SELECT t.id, t.tags")) return { rows: candidateRows, rowCount: candidateRows.length };
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

/** The report's aggregate query (the one grouping by category). */
const reportQuery = () => {
  const q = executed.find((e) => e.sql.includes("GROUP BY") && e.sql.includes("FROM transactions t"));
  expect(q).toBeDefined();
  return q!.sql;
};
const payload = (res: { content: Array<{ text: string }> }) => {
  const body = JSON.parse(res.content[0].text);
  return body.data ?? body;
};

const cases: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "get_spending_trends", args: { period: "monthly" } },
  { name: "get_income_statement", args: { start_date: "2026-01-01", end_date: "2026-12-31" } },
];

describe.each(cases)("$name business/tag scoping", ({ name, args }) => {
  const run = async (extra: Record<string, unknown>) => {
    executed = [];
    return tools[name].handler({ ...args, ...extra }, {});
  };

  it("applies no business or tag condition by default", async () => {
    const res = await run({});
    const q = reportQuery();
    expect(q).not.toContain("is_business");
    expect(q).not.toContain("ANY(ARRAY");
    expect(executed.some((e) => e.sql.includes("SELECT t.id, t.tags"))).toBe(false);
    expect(payload(res).filters).toEqual({ business: "all", tag: null });
  });

  it("business: true (and \"true\") scopes to is_business = 1", async () => {
    for (const business of [true, "true"]) {
      const res = await run({ business });
      expect(reportQuery()).toContain("t.is_business = 1");
      expect(payload(res).filters.business).toBe("business");
    }
  });

  it("business: false scopes to personal (NULL counts as personal)", async () => {
    const res = await run({ business: "false" });
    expect(reportQuery()).toContain("COALESCE(t.is_business, 0) = 0");
    expect(payload(res).filters.business).toBe("personal");
  });

  it("business: all applies no condition", async () => {
    await run({ business: "all" });
    expect(reportQuery()).not.toContain("is_business");
  });

  it("tag restricts to rows carrying the exact tag (decrypted in memory)", async () => {
    candidateRows = taggedRows();
    const res = await run({ tag: "work" });
    const q = reportQuery();
    expect(q).toContain("t.id = ANY(ARRAY[11,13]::int[])");
    expect(payload(res).filters.tag).toBe("work");
  });

  it("tag combines with business, which also narrows the candidate read", async () => {
    candidateRows = taggedRows();
    await run({ tag: "work", business: false });
    const candidate = executed.find((e) => e.sql.includes("SELECT t.id, t.tags"))!;
    expect(candidate.sql).toContain("COALESCE(t.is_business, 0) = 0");
    const q = reportQuery();
    expect(q).toContain("COALESCE(t.is_business, 0) = 0");
    expect(q).toContain("ANY(ARRAY[11,13]");
  });

  it("a tag nobody carries yields an empty report, not an unfiltered one", async () => {
    candidateRows = taggedRows();
    await run({ tag: "client-x" });
    const q = reportQuery();
    expect(q).toContain("AND FALSE");
    expect(q).not.toContain("ANY(ARRAY");
  });
});
