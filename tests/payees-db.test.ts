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

describeDb("Payee Studio P2 MCP writes (seeded DB)", () => {
  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });

  it("merge is two-step, binds the token to the rows, masks identifiers and undoes", async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches RESTART IDENTITY CASCADE`);
    const { userId } = await seedPayeeLedger();
    const call = await mcpTools(userId, TEST_DEK);

    const clusters = await call({ op: "clusters", include_needs_decision: false });
    const epi = clusters.clusters.find((c: { members: Array<{ key: string }> }) => c.members.some((m) => m.key === payeeMatchKey("Епіцентр К")));
    const args = { op: "merge", into_name: "Епіцентр", into_type: "retail", cluster_ids: [epi.cluster_id] };
    const preview = await call(args);
    expect(preview.preview).toBe(true);
    expect(preview.rows.byTable).toEqual({ transactions: 10, recurring: 1, staged: 1 });
    expect(typeof preview.confirmationToken).toBe("string");
    // Nothing written by the preview.
    expect((await call({ op: "list", view: "entities" })).total).toBe(0);

    // A token for different arguments is refused.
    const wrong = await call({ ...args, into_name: "Epicentr", confirmation_token: preview.confirmationToken });
    expect(wrong.error).toMatch(/token invalid/i);

    const done = await call({ ...args, confirmation_token: (await call(args)).confirmationToken });
    expect(done.error ?? null).toBeNull();
    expect(done.changed).toBe(12);
    expect(done.batch_id).toBeGreaterThan(0);
    const ents = await call({ op: "list", view: "entities" });
    expect(ents.entities[0]).toMatchObject({ name: "Епіцентр", count: 30 });

    const idArgs = { op: "identifiers", entity_id: done.entity.entity_id, add: [{ kind: "card_last4", value: "4149439312345678" }, { kind: "iban", value: "UA213223130000026007233566001" }] };
    const idDone = await call({ ...idArgs, confirmation_token: (await call(idArgs)).confirmationToken });
    expect(JSON.stringify(idDone)).not.toContain("4149439312345678");
    const got = await call({ op: "get", entity_id: done.entity.entity_id });
    expect(got.entity.identifiers.map((i: { value: string }) => i.value)).toEqual(["•••• 5678", "UA21…6001"]);
    expect(got.history.length).toBe(2);

    // Undo the identifiers first (newest), then the merge.
    const u1 = { op: "undo", batch_id: idDone.batch_id };
    await call({ ...u1, confirmation_token: (await call(u1)).confirmationToken });
    const u2 = { op: "undo", batch_id: done.batch_id };
    const undone = await call({ ...u2, confirmation_token: (await call(u2)).confirmationToken });
    expect(undone.undo.restoredRows).toBe(12);
    expect((await call({ op: "list", view: "entities" })).total).toBe(0);

    // Without a DEK every write is refused before any work.
    const locked = await mcpTools(userId, null);
    expect((await locked({ op: "create", name: "X" })).error).toMatch(/Unlock required/);
  });
});
