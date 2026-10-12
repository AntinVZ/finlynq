/**
 * Payee Studio P6.2 against a real Postgres: a full card number is REFUSED
 * everywhere it can be typed — op identifiers / create (preview and commit),
 * MCP manage_payees identifiers / create / propose / whose and
 * search_transactions identifier / payee_resolve — and leaves no trace: no
 * identifier row, no batch (journal), no proposal. The server log scrubber
 * redacts one too. SKIPS the DB part unless DATABASE_URL names a `*_test`
 * database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";
import { scrubSensitive } from "@/lib/server-logger";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

const PAN = "4149 4999 1234 5678";
const REFUSED = /Повний номер картки не приймається/;

describe("server log scrubber", () => {
  it("redacts a full card number", () => {
    expect(scrubSensitive(`bad value ${PAN} in request`)).toBe("bad value <redacted-card> in request");
    expect(scrubSensitive("card=4149499912345678")).not.toContain("4149");
    expect(scrubSensitive("•••• 5678")).toBe("•••• 5678");
  });
});

describeDb("Payee Studio P6.2: a full card number is refused everywhere (seeded DB)", () => {
  let seed: SeededPayees;
  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_proposals, payee_merchant_types, payee_own_accounts RESTART IDENTITY CASCADE`);
    seed = await seedPayeeLedger();
  });

  const op = async (o: unknown, dryRun = false) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, op: o as any, actor: "web", dryRun });
  };
  const count = async (table: "payee_identifiers" | "payee_batches" | "payee_proposals" | "payee_entities") => {
    const { db } = await import("@/db");
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE user_id = ${seed.userId}`)) as unknown as { rows: Array<{ n: number }> };
    return Number(r.rows[0].n);
  };
  const tools = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-p6-2-fullcard", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await t[name].handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };

  it("op identifiers and create refuse it in the preview and the commit; nothing is stored or journaled", async () => {
    const made = await op({ op: "create", name: "Коваль Петро", apply: false });
    const entityId = made.entity!.id;
    const batchesBefore = await count("payee_batches");
    for (const dry of [true, false]) {
      await expect(op({ op: "identifiers", entityId, add: [{ kind: "card_last4", value: PAN }] }, dry)).rejects.toThrow(REFUSED);
      await expect(op({ op: "create", name: "Інший", identifiers: [{ kind: "card_last4", value: "4149499912345678" }], apply: false }, dry)).rejects.toThrow(REFUSED);
    }
    expect(await count("payee_identifiers")).toBe(0);
    expect(await count("payee_batches")).toBe(batchesBefore);
    expect(await count("payee_entities")).toBe(1);
    // The last 4 digits or a mask still work.
    await op({ op: "identifiers", entityId, add: [{ kind: "card_last4", value: "**** 5678" }] });
    expect(await count("payee_identifiers")).toBe(1);
  });

  it("MCP: identifiers, create, propose, whose and search_transactions refuse it; no batch, no proposal", async () => {
    const call = await tools();
    const made = await op({ op: "create", name: "Коваль Петро", apply: false });
    const batchesBefore = await count("payee_batches");
    const r1 = await call("manage_payees", { op: "identifiers", entity_id: made.entity!.id, add: [{ kind: "card_last4", value: PAN }] });
    expect(r1.error).toMatch(REFUSED);
    const r2 = await call("manage_payees", { op: "create", name: "Інший", identifiers: [{ kind: "card_last4", value: PAN }] });
    expect(r2.error).toMatch(REFUSED);
    const r3 = await call("manage_payees", { op: "whose", identifier: PAN });
    expect(r3.error).toMatch(REFUSED);
    const r4 = await call("search_transactions", { identifier: PAN });
    expect(r4.error).toMatch(REFUSED);
    const r5 = await call("search_transactions", { payee_resolve: "4149499912345678" });
    expect(r5.error).toMatch(REFUSED);
    const r6 = await call("manage_payees", { op: "propose", proposals: [{ canonical: "Коваль Петро", identifiers: [{ kind: "card_last4", value: PAN }], reason: "x", confidence: 0.5 }] });
    expect(JSON.stringify(r6)).toMatch(REFUSED);
    for (const r of [r1, r2, r3, r4, r5, r6]) expect(JSON.stringify(r)).not.toMatch(/4149|41494999/);
    expect(await count("payee_identifiers")).toBe(0);
    expect(await count("payee_batches")).toBe(batchesBefore);
    expect(await count("payee_proposals")).toBe(0);
  });
});
