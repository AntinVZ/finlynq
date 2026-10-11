/**
 * MCP bulk filter (`bulkFilterSchema`, shared by preview/execute_bulk_update,
 * _delete and _categorize): note_match, tag_exact, business, min/max_amount,
 * and paged text matching with `truncated`.
 *
 * DB-free: the tools run against a mock `execute` that serves a synthetic,
 * newest-first ledger with real ciphertext and honours LIMIT / OFFSET.
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
import { matchesTextFilters, hasTextFilter } from "../../mcp-server/lib/text-match";

type Tool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

const dek = Buffer.alloc(32, 5);
const dialect = new PgDialect();
let executed: Array<{ sql: string; params: unknown[] }> = [];
let ledger: Array<{ id: number; payee: string | null; note: string | null; tags: string | null }> = [];
let tools: Record<string, Tool>;

const EMPTY = encryptField(dek, "");
const COFFEE = encryptField(dek, "Coffee");

/** Newest-first ledger; `pick(i)` overrides payee / note / tags of row i. */
function makeLedger(n: number, pick: (i: number) => { payee?: string; note?: string; tags?: string } = () => ({})) {
  return Array.from({ length: n }, (_, i) => {
    const o = pick(i);
    return {
      id: n - i,
      payee: o.payee !== undefined ? encryptField(dek, o.payee) : COFFEE,
      note: o.note !== undefined ? encryptField(dek, o.note) : EMPTY,
      tags: o.tags !== undefined ? encryptField(dek, o.tags) : EMPTY,
    };
  });
}

const isTextScan = (s: string) => s.includes("SELECT id, payee, note, tags FROM transactions");
const isIdScan = (s: string) => /SELECT id FROM transactions\s+WHERE[\s\S]*ORDER BY date DESC, id DESC/.test(s);

beforeAll(() => {
  const server = withAutoAnnotations(new McpServer({ name: "bulk-filter-test", version: "0.0.0" }));
  registerPgTools(
    server,
    {
      execute: async (query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        executed.push({ sql: rendered.sql, params: rendered.params });
        if (isTextScan(rendered.sql)) {
          const [size, offset] = rendered.params.slice(-2) as [number, number];
          const rows = ledger.slice(offset, offset + size);
          return { rows, rowCount: rows.length };
        }
        if (isIdScan(rendered.sql)) {
          const size = rendered.params[rendered.params.length - 1] as number;
          const rows = ledger.slice(0, size).map((r) => ({ id: r.id }));
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
  const raw = res.content[0].text;
  let body: Record<string, unknown> & { data?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    body = { error: raw }; // err() returns plain text
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: res.isError === true || raw.startsWith("Error:"), body, data: (body.data ?? body) as any };
};
const scanSql = () => executed.find((e) => isTextScan(e.sql) || isIdScan(e.sql))!;

describe("bulk filter: note_match / payee_match / tag_exact", () => {
  it("note_match finds a match on row 1100 by paging the scan", async () => {
    ledger = makeLedger(1200, (i) => (i === 1100 ? { note: "Поповнення рахунку" } : {}));
    const { data } = await call("preview_bulk_delete", { filter: { note_match: "поповнення" } });
    expect(data.affectedCount).toBe(1);
    expect(data.truncated).toBe(false);
    expect(typeof data.confirmationToken).toBe("string");
    expect(executed.filter((e) => isTextScan(e.sql)).length).toBeGreaterThan(1);
  });

  it("payee_match still matches the payee only", async () => {
    ledger = makeLedger(3, (i) => (i === 1 ? { note: "Landlord" } : {}));
    const { data } = await call("preview_bulk_delete", { filter: { payee_match: "landlord" } });
    expect(data.affectedCount).toBe(0);
  });

  it("tag_exact matches whole tags, case-insensitively", async () => {
    ledger = makeLedger(3, (i) => ({ tags: ["travel,work", "homework", "Work"][i] }));
    const upd = await call("preview_bulk_update", { filter: { tag_exact: "work" }, changes: { note: "x" } });
    expect(upd.data.affectedCount).toBe(2);
  });

  it("text filters AND together", async () => {
    ledger = makeLedger(3, (i) => [
      { payee: "Silpo", note: "weekly" },
      { payee: "Silpo", note: "party" },
      { payee: "ATB", note: "weekly" },
    ][i]);
    const { data } = await call("preview_bulk_update", { filter: { payee_match: "silpo", note_match: "weekly" }, changes: { note: "x" } });
    expect(data.affectedCount).toBe(1);
  });
});

describe("bulk filter: SQL-side business / amount", () => {
  beforeEach(() => {
    ledger = makeLedger(2);
  });

  it("business: true → is_business = 1; false → COALESCE(is_business, 0) = 0; all → none", async () => {
    await call("preview_bulk_delete", { filter: { business: true } });
    expect(scanSql().sql).toContain("is_business = 1");
    executed = [];
    await call("preview_bulk_delete", { filter: { business: "false" } });
    expect(scanSql().sql).toContain("COALESCE(is_business, 0) = 0");
    executed = [];
    await call("preview_bulk_delete", { filter: { business: "all", account_id: 3 } });
    expect(scanSql().sql).not.toContain("is_business");
  });

  it("business: all alone is not a filter", async () => {
    const res = await call("preview_bulk_delete", { filter: { business: "all" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.body)).toContain("At least one filter field is required");
  });

  it("min/max_amount are signed SQL bounds", async () => {
    await call("preview_bulk_delete", { filter: { min_amount: -1500, max_amount: -500 } });
    const q = scanSql();
    expect(q.sql).toContain("amount >= $");
    expect(q.sql).toContain("amount <= $");
    expect(q.params).toContain(-1500);
    expect(q.params).toContain(-500);
  });

  it("without a text filter reads ids in one query", async () => {
    await call("preview_bulk_delete", { filter: { business: true } });
    expect(executed.filter((e) => isIdScan(e.sql))).toHaveLength(1);
    expect(executed.some((e) => isTextScan(e.sql))).toBe(false);
  });
});

describe("bulk filter: truncation", () => {
  it("over 10,000 SQL matches → preview truncated, no token; execute refuses", async () => {
    ledger = makeLedger(10_001);
    const prev = await call("preview_bulk_delete", { filter: { start_date: "2000-01-01" } });
    expect(prev.data.truncated).toBe(true);
    expect(prev.data.confirmationToken).toBeUndefined();
    expect(prev.data.note).toMatch(/narrow the filter/);

    const exec = await call("execute_bulk_delete", { filter: { start_date: "2000-01-01" }, confirmation_token: "anything" });
    expect(exec.isError).toBe(true);
    expect(JSON.stringify(exec.body)).toContain("Refusing to execute");
  });

  it("exactly 10,000 matches is not truncated", async () => {
    ledger = makeLedger(10_000);
    const prev = await call("preview_bulk_delete", { filter: { start_date: "2000-01-01" } });
    expect(prev.data.truncated).toBe(false);
    expect(typeof prev.data.confirmationToken).toBe("string");
  });

  it("text scan stopping at its bound → preview_bulk_update truncated; execute refuses", async () => {
    ledger = makeLedger(50_001); // nothing matches; one row past the scan bound
    const filter = { note_match: "nobody" };
    const prev = await call("preview_bulk_update", { filter, changes: { note: "x" } });
    expect(prev.data.affectedCount).toBe(0);
    // Zero matches in a truncated scan is reported as truncated, not "no match".
    expect(prev.data.truncated).toBe(true);
    expect(prev.data.note).toMatch(/narrow the filter/);
    expect(prev.data.confirmationToken).toBeUndefined();
    const del = await call("preview_bulk_delete", { filter });
    expect(del.data.truncated).toBe(true);
    expect(del.data.note).toMatch(/narrow the filter/);

    ledger = makeLedger(50_001, (i) => (i === 0 ? { note: "somebody" } : {}));
    const prev2 = await call("preview_bulk_update", { filter: { note_match: "somebody" }, changes: { note: "x" } });
    expect(prev2.data.affectedCount).toBe(1);
    expect(prev2.data.truncated).toBe(true);
    expect(prev2.data.confirmationToken).toBeUndefined();

    const exec = await call("execute_bulk_update", { filter: { note_match: "somebody" }, changes: { note: "x" }, confirmation_token: "t" });
    expect(exec.isError).toBe(true);
    expect(JSON.stringify(exec.body)).toContain("Refusing to execute");
  }, 60_000);
});

describe("matchesTextFilters", () => {
  const row = { payee: "Silpo", note: "Weekly groceries", tags: "food,Home" };

  it("no filters matches everything; hasTextFilter is false", () => {
    expect(hasTextFilter({})).toBe(false);
    expect(hasTextFilter({ payee: "", tagExact: "  " })).toBe(false);
    expect(matchesTextFilters(row, {})).toBe(true);
  });

  it("each field filter looks at its own field", () => {
    expect(matchesTextFilters(row, { payee: "SIL" })).toBe(true);
    expect(matchesTextFilters(row, { payee: "weekly" })).toBe(false);
    expect(matchesTextFilters(row, { note: "GROCER" })).toBe(true);
    expect(matchesTextFilters(row, { tags: "hom" })).toBe(true);
  });

  it("search is payee OR note OR tags", () => {
    expect(matchesTextFilters(row, { search: "silpo" })).toBe(true);
    expect(matchesTextFilters(row, { search: "weekly" })).toBe(true);
    expect(matchesTextFilters(row, { search: "food" })).toBe(true);
    expect(matchesTextFilters(row, { search: "atb" })).toBe(false);
  });

  it("filters AND together; tagExact is a whole tag", () => {
    expect(matchesTextFilters(row, { payee: "silpo", tagExact: "home" })).toBe(true);
    expect(matchesTextFilters(row, { payee: "silpo", tagExact: "hom" })).toBe(false);
    expect(matchesTextFilters(row, { payee: "atb", note: "weekly" })).toBe(false);
  });

  it("null fields never match a set filter", () => {
    expect(matchesTextFilters({ payee: null, note: null, tags: null }, { search: "x" })).toBe(false);
    expect(matchesTextFilters({ payee: null }, { payee: "x" })).toBe(false);
  });
});
