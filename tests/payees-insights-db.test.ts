/**
 * Payee Studio P4 against a real Postgres: insights, search_transactions
 * payee_resolve, and the dictionary import route (preview → decision →
 * commit → undo). SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

let authedUser = "";
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: authedUser, method: "account", dek: Buffer.alloc(32, 0xaa), sessionId: "test-session" },
  })),
}));

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";
import { encryptField } from "@/lib/crypto/envelope";
import { createMockRequest, parseResponse } from "./helpers/api-test-utils";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("Payee Studio P4 (seeded DB)", () => {
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
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_proposals RESTART IDENTITY CASCADE`);
    seed = await seedPayeeLedger();
    authedUser = seed.userId;
  });

  const tools = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-p4", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await t[name].handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };
  const createEntity = async (op: Record<string, unknown>) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, actor: "web", op: op as any });
  };

  it("insights: counterparties resolve through the directory; recurring, gone, concentration", async () => {
    const { db } = await import("@/db");
    await createEntity({ op: "create", name: "Епіцентр", type: "retail", apply: false, aliases: [{ pattern: "Епіцентр К" }] });
    // A monthly subscription that stopped in March.
    for (const d of ["2025-10-03", "2025-11-03", "2025-12-03", "2026-01-03", "2026-02-03", "2026-03-03"]) {
      await db.execute(sql`INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source)
        VALUES (${seed.userId}, ${d}, ${seed.accountId}, 'UAH', -199, ${encryptField(TEST_DEK, "Netflix")}, 'manual')`);
    }
    const call = await tools();
    const ins = await call("manage_payees", { op: "insights", months: 12, limit: 5 });
    expect(ins.currency).toBe("UAH");
    const epi = ins.topByCount.find((c: { name: string }) => c.name === "Епіцентр");
    expect(epi.entityId).toBeGreaterThan(0);
    expect(epi.count).toBeGreaterThanOrEqual(30 - 10); // all spellings + "Епіцентр К" fold into one counterparty (window may cut a few)
    expect(ins.topBySpend[0].spend).toBeGreaterThan(0);
    expect(ins.monthly.months).toHaveLength(12);
    expect(ins.monthly.series.at(-1).name).toBe("Everyone else");
    expect(ins.concentration.top5Share).toBeGreaterThan(0.5);
    const netflix = [...ins.recurring, ...ins.goneCounterparties].find((c: { name: string }) => c.name === "Netflix");
    expect(netflix).toMatchObject({ cadence: "monthly" });
    expect(JSON.stringify(ins)).not.toMatch(/v1:/);
  });

  it("search_transactions payee_resolve: by alias, by requisite, and by spelling outside the directory", async () => {
    const e = await createEntity({ op: "create", name: "Епіцентр", type: "retail", apply: false, identifiers: [{ kind: "edrpou", value: "32490244" }] });
    const call = await tools();
    const byAlias = await call("search_transactions", { payee_resolve: "epitcentr k10 kyiv 000000", limit: 100 });
    expect(byAlias.count).toBe(28);
    expect(byAlias.filters.payee_resolve).toMatchObject({ kind: "entity", entityId: e.entity!.id, name: "Епіцентр" });
    const byId = await call("search_transactions", { payee_resolve: "32490244", limit: 100 });
    expect(byId.count).toBe(28);
    expect(byId.filters.payee_resolve.kind).toBe("identifier");
    const outside = await call("search_transactions", { payee_resolve: "Атб маркет", limit: 100 });
    expect(outside.count).toBe(10);
    expect(outside.filters.payee_resolve.kind).toBe("spelling");
    const combined = await call("search_transactions", { payee_resolve: "ATB", min_amount: -200, limit: 100 });
    expect(combined.count).toBe(0); // "ATB" alone is another key; filters still AND
  });

  it("dictionary: export hides people; import previews, needs decisions, commits as one undoable batch", async () => {
    await createEntity({ op: "create", name: "Епіцентр", type: "retail", apply: false, aliases: [{ pattern: "Epicentr" }], identifiers: [{ kind: "edrpou", value: "32490244" }] });
    await createEntity({ op: "create", name: "Деркач Олександр Петрович", type: "person", apply: false });
    const route = await import("@/app/api/payees/dictionary/route");
    const exp = await route.GET(createMockRequest("http://localhost:3000/api/payees/dictionary?format=yaml"));
    expect(exp.headers.get("content-disposition")).toMatch(/finlynq-payees-.*\.yaml/);
    const yaml = await exp.text();
    expect(yaml).toContain('name: "Епіцентр"');
    expect(yaml).not.toContain("Деркач");

    const file = JSON.stringify({
      format: "finlynq-payee-dictionary",
      version: 1,
      entries: [
        { name: "ATB", type: "retail", aliases: ["Атб Маркет"], identifiers: [{ kind: "edrpou", value: "30487219" }] },
        { name: "Epicentr K", type: "company", aliases: ["Епіцентр К", "Epicentr"] },
      ],
    });
    const post = async (body: unknown) => parseResponse(await route.POST(createMockRequest("http://localhost:3000/api/payees/dictionary", { method: "POST", body })));
    const dry = await post({ content: file, dryRun: true });
    expect((dry.data as { counts: Record<string, number> }).counts).toMatchObject({ create: 1, conflict: 0, merge: 1 });
    const committed = await post({ content: file });
    expect(committed.status).toBe(200);
    const batchId = (committed.data as { batchId: number }).batchId;
    const { db } = await import("@/db");
    const { loadDirectory } = await import("@/lib/payees/directory");
    const dir = await loadDirectory(db, seed.userId, TEST_DEK);
    expect(dir.map((d) => d.name).sort()).toEqual(["ATB", "Деркач Олександр Петрович", "Епіцентр"].sort());
    expect(dir.find((d) => d.name === "Епіцентр")!.aliases.map((a) => a.pattern)).toContain("Epicentr K"); // same key as "Епіцентр К": one alias
    // Payees are not renamed by an import.
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM payee_batches WHERE id = ${batchId}`)) as unknown as { rows: Array<{ n: number }> };
    expect(n.rows[0].n).toBe(1);
    const { undoPayeeBatch } = await import("@/lib/payees/batches");
    const u = await undoPayeeBatch({ executor: db, userId: seed.userId, dek: TEST_DEK, batchId });
    expect(u.restoredRows).toBe(0);
    expect((await loadDirectory(db, seed.userId, TEST_DEK)).map((d) => d.name).sort()).toEqual(["Деркач Олександр Петрович", "Епіцентр"].sort());

    // A conflict blocks the commit until decided.
    const clash = JSON.stringify({ format: "finlynq-payee-dictionary", version: 1, entries: [{ name: "Epicentr Mix", aliases: ["Epicentr", "Деркач Олександр Петрович"] }] });
    const blocked = await post({ content: clash });
    expect(blocked.status).toBe(409);
    const decided = await post({ content: clash, resolutions: { "0": "skip" } });
    expect(decided.status).toBe(200);
    expect((await post({ content: "not a dictionary" })).status).toBe(400);
  });
});
