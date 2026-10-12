/**
 * Payee Studio P6.1 against a real Postgres: the merchant type as the main
 * type of a new payee (merge into a new entry, create), «Особи і ФОП» making
 * the entry a person, undo, MCP create / merge with merchant_type, and the
 * alias spellings the web picker searches. SKIPS unless DATABASE_URL names a
 * `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("Payee Studio P6.1 merchant type as the main type (seeded DB)", () => {
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
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_proposals, payee_merchant_types RESTART IDENTITY CASCADE`);
    seed = await seedPayeeLedger();
  });

  const op = async (o: unknown, dryRun = false) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, op: o as any, actor: "web", dryRun });
  };
  const dir = async () => (await import("@/lib/payees/directory")).loadDirectory((await import("@/db")).db, seed.userId, TEST_DEK);
  const types = async () => (await import("@/lib/payees/merchant-types")).loadMerchantTypes((await import("@/db")).db, seed.userId);
  const typeName = async (id: number | null) => (id == null ? null : ((await types()).find((t) => t.id === id)?.name ?? null));
  const tools = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-p6-1", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await t[name].handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };

  it("merges spellings into a new payee with a merchant type; preview writes nothing; undo removes it", async () => {
    const body = { op: "merge", into: { name: "Епіцентр", merchantType: "Ремонт і будівництво" }, payees: ["Епіцентр", "Epicentr"] };
    const preview = await op(body, true);
    expect(preview.typed).toEqual([{ id: expect.any(Number), name: "Епіцентр", from: null, to: "Ремонт і будівництво" }]);
    expect(await dir()).toHaveLength(0);

    const done = await op(body);
    const [e] = await dir();
    expect(e.name).toBe("Епіцентр");
    expect(await typeName(e.merchantTypeId)).toBe("Ремонт і будівництво");
    expect(e.type).toBe("retail"); // no signal in the name → retail for a merchant type
    expect(done.rows.total).toBeGreaterThan(0);

    await op({ op: "undo", batchId: done.batchId });
    expect(await dir()).toHaveLength(0);
  });

  it("an explicit entity type still wins over the derived one", async () => {
    await op({ op: "merge", into: { name: "Епіцентр", type: "company", merchantType: "Ремонт і будівництво" }, payees: ["Epicentr"], apply: false });
    expect((await dir())[0].type).toBe("company");
  });

  it("«Особи і ФОП» makes a person (or a sole proprietor for ФОП), on create, merge and update", async () => {
    await op({ op: "create", name: "Сантехнік Василь", merchantType: "Особи і ФОП", apply: false });
    await op({ op: "create", name: "ФОП Коваль Іван Петрович", merchantType: "Особи і ФОП", apply: false });
    await op({ op: "merge", into: { name: "Няня", merchantType: "Особи і ФОП" }, payees: ["Няня Оля"], apply: false });
    const s = await op({ op: "create", name: "Сільпо", apply: false });
    expect(s.entity!.type).not.toBe("person");
    const u = await op({ op: "update", entityId: s.entity!.id, merchantType: "Особи і ФОП" });
    let d = await dir();
    const typeOf = (n: string) => d.find((e) => e.name === n)!.type;
    expect(typeOf("Сантехнік Василь")).toBe("person");
    expect(typeOf("ФОП Коваль Іван Петрович")).toBe("sole_proprietor");
    expect(typeOf("Няня")).toBe("person");
    expect(typeOf("Сільпо")).toBe("person");
    // Undo puts the old entity type back together with the merchant type.
    await op({ op: "undo", batchId: u.batchId });
    d = await dir();
    expect(typeOf("Сільпо")).toBe(s.entity!.type);
    expect(d.find((e) => e.name === "Сільпо")!.merchantTypeId).toBeNull();
  });

  it("a person-looking name stays a person whatever merchant type is picked", async () => {
    await op({ op: "create", name: "Шевченко Тарас Григорович", merchantType: "Супермаркети і продукти", apply: false });
    expect((await dir())[0].type).toBe("person");
  });

  it("MCP: create and merge with merchant_type", async () => {
    const call = await tools();
    const args = { op: "merge", into_name: "Епіцентр", into_merchant_type: "Ремонт і будівництво", payees: ["Епіцентр", "Epicentr"] };
    const p = await call("manage_payees", args);
    expect(p.preview).toBe(true);
    const done = await call("manage_payees", { ...args, confirmation_token: p.confirmationToken });
    expect(done.error).toBeUndefined();
    const c = await call("manage_payees", { op: "create", name: "Іваненко Петро", merchant_type: "Особи і ФОП", apply: false });
    const created = await call("manage_payees", { op: "create", name: "Іваненко Петро", merchant_type: "Особи і ФОП", apply: false, confirmation_token: c.confirmationToken });
    expect(created.error).toBeUndefined();
    const list = await call("manage_payees", { op: "list", view: "entities" });
    const byName = Object.fromEntries(list.entities.map((e: { name: string }) => [e.name, e]));
    expect(byName["Епіцентр"].merchant_type).toBe("Ремонт і будівництво");
    expect(byName["Іваненко Петро"]).toMatchObject({ merchant_type: "Особи і ФОП", type: "person" });
  });

  it("the overview lists alias spellings for the picker (no canonical name, no regexes)", async () => {
    await op({
      op: "create",
      name: "McDonald's",
      apply: false,
      aliases: [{ pattern: "Макдональдз" }, { pattern: "MCDONALDS", mode: "contains" }, { pattern: "^MCD\\d+", mode: "regex" }],
    });
    const { db } = await import("@/db");
    const { loadPayeeOverview } = await import("@/lib/payees/service");
    const o = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK });
    expect(o.entities[0].aliasNames.sort()).toEqual(["MCDONALDS", "Макдональдз"]);
    expect(o.entities[0].aliasCount).toBe(4);
  });
});
