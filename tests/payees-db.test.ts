/**
 * Payee Studio against a real Postgres: the scan over every payee table,
 * the overview, and the MCP `manage_payees` read ops. SKIPS unless
 * DATABASE_URL names a `*_test` database (same gate as the other DB-backed
 * suites), so the default `vitest run` stays DB-free.
 *
 * Run: DATABASE_URL=postgres://…/finlynq_test npx vitest run tests/payees-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger } from "./helpers/payee-db-seed";
import { payeeMatchKey } from "@/lib/payees/match-key";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Tool = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }> };

async function mcpTools(userId: string, dek: Buffer | null) {
  const { db } = await import("@/db");
  const { registerPgTools } = await import("../mcp-server/register-tools-pg");
  const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
  const server = withAutoAnnotations(new McpServer({ name: "payees-db", version: "0" }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPgTools(server, db as any, userId, dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, Tool>;
  return async (args: Record<string, unknown>) => {
    const raw = (await tools.manage_payees.handler(args, {})).content[0].text;
    if (raw.startsWith("Error:")) return { error: raw };
    return JSON.parse(raw).data;
  };
}

describeDb("Payee Studio P1 (seeded DB)", () => {
  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });

  it("scans every payee table in batches and aggregates per spelling", async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    const { scanPayees } = await import("@/lib/payees/scan");
    const { userId } = await seedPayeeLedger();
    const scan = await scanPayees({ executor: db, userId, dek: TEST_DEK, batchSize: 7 });
    expect(scan.scanned.transactions).toBe(54);
    expect(scan.scanned.recurring).toBe(1);
    expect(scan.scanned.staged).toBe(2);
    expect(scan.scanned.bank).toBe(1);
    expect(scan.undecryptable).toBe(0);
    const epi = scan.spellings.get("Епіцентр")!;
    expect(epi.counts).toMatchObject({ transactions: 20, bank: 1 });
    expect(scan.spellings.get("EPITCENTR K10 KYIV 360616")!.counts).toMatchObject({ transactions: 3, staged: 1 });
    expect(scan.spellings.get("Epicentr")!.counts.recurring).toBe(1);

    // Without a DEK the encrypted rows are counted, never shown as ciphertext.
    const locked = await scanPayees({ executor: db, userId, dek: null });
    expect([...locked.spellings.keys()].some((k) => k.startsWith("v1:"))).toBe(false);
    expect(locked.undecryptable).toBe(54 + 1 + 1);
  });

  it("caps a source and reports it truncated", async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    const { scanPayees } = await import("@/lib/payees/scan");
    const { userId } = await seedPayeeLedger();
    const scan = await scanPayees({ executor: db, userId, dek: TEST_DEK, sources: ["transactions"], batchSize: 10, maxPerSource: 30 });
    expect(scan.scanned.transactions).toBe(30);
    expect(scan.truncated).toEqual(["transactions"]);
  });

  it("MCP manage_payees list / clusters / get", async () => {
    await resetTestDb();
    const { userId } = await seedPayeeLedger();
    const call = await mcpTools(userId, TEST_DEK);

    const list = await call({ op: "list", limit: 3 });
    expect(list.payees[0]).toMatchObject({ name: "Епіцентр", count: 28 });
    expect(list.payees[0].spellings.map((s: { spelling: string }) => s.spelling)).toContain("EPITCENTR K10 KYIV 360616");
    expect(list.total).toBeGreaterThan(5);

    const clusters = await call({ op: "clusters" });
    const epi = clusters.clusters.find((c: { members: Array<{ key: string }> }) => c.members.some((m) => m.key === payeeMatchKey("Епіцентр К")));
    expect(epi.members.map((m: { key: string }) => m.key)).toContain(payeeMatchKey("Epicentr"));
    const person = clusters.clusters.find((c: { members: Array<{ key: string }> }) => c.members.some((m) => m.key === payeeMatchKey("Деркач Олександр Петрович")));
    expect(person.needsDecision).toBe(true);
    const merchantsOnly = await call({ op: "clusters", include_needs_decision: false });
    expect(merchantsOnly.clusters.every((c: { needsDecision: boolean }) => !c.needsDecision)).toBe(true);

    const got = await call({ op: "get", payee: "epitcentr k10 kyiv 999999" });
    expect(got.payee.name).toBe("Епіцентр");
    expect(got.payee.sources).toMatchObject({ transactions: 28, recurring: 1, staged: 1, bank: 1 });
    const byCluster = await call({ op: "get", cluster_id: epi.cluster_id });
    expect(byCluster.groups.length).toBe(2);
    expect((await call({ op: "get", payee: "nobody at all" })).error).toMatch(/No payee/);
  });

  it("read ops are logged as reads", async () => {
    const { isWriteCall } = await import("@/lib/mcp/activity-log");
    expect(isWriteCall("manage_payees", "list")).toBe(false);
    expect(isWriteCall("manage_payees", "clusters")).toBe(false);
    expect(isWriteCall("manage_payees", "get")).toBe(false);
  });
});
