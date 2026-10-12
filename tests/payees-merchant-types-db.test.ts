/**
 * Payee Studio P6 stage 3 against a real Postgres: merchant types on
 * entities, the editable dictionary, bulk assignment by a type word, the
 * 30-day undo, MCP filters and the dictionary file. SKIPS unless
 * DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";
import { encryptField } from "@/lib/crypto/envelope";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("Payee Studio P6 merchant types (seeded DB)", () => {
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
  const tools = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-p6-types", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await t[name].handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };

  it("existing entries start without a type; the starting set is virtual until the first change", async () => {
    await op({ op: "create", name: "Епіцентр", apply: false });
    expect((await dir())[0].merchantTypeId).toBeNull();
    const list = await types();
    expect(list.every((t) => t.id == null)).toBe(true);
    const { db } = await import("@/db");
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM payee_merchant_types`)) as unknown as { rows: Array<{ n: number }> };
    expect(n.rows[0].n).toBe(0);
  });

  it("sets a type on create / update, previews first, and undoes", async () => {
    const preview = await op({ op: "create", name: "Ресторан Дача", apply: false, merchantType: "Ресторани" }, true);
    expect(preview.typed).toEqual([{ id: expect.any(Number), name: "Ресторан Дача", from: null, to: "Кафе, ресторани, бари → Ресторани" }]);
    expect((await dir())).toHaveLength(0);
    const c = await op({ op: "create", name: "Ресторан Дача", apply: false, merchantType: "Ресторани" });
    const list = await types();
    expect(list.every((t) => t.id != null)).toBe(true); // the starting set is now stored
    const rest = list.find((t) => t.name === "Ресторани")!;
    expect((await dir())[0].merchantTypeId).toBe(rest.id);

    const u = await op({ op: "update", entityId: c.entity!.id, merchantType: { group: "Кафе, ресторани, бари", name: "Бари" } });
    expect(u.typed[0]).toMatchObject({ from: "Кафе, ресторани, бари → Ресторани", to: "Кафе, ресторани, бари → Бари" });
    await op({ op: "undo", batchId: u.batchId });
    expect((await dir())[0].merchantTypeId).toBe(rest.id);
  });

  // P6.2 (B29): only the canonical name decides; "Doctor" (alias-only match) is skipped, not typed.
  it("assigns one type in bulk by a type word, only to untyped entries", async () => {
    const a = await op({ op: "create", name: "Аптека Подорожник", apply: false });
    await op({ op: "create", name: "Doctor", apply: false, aliases: [{ pattern: "Apteka Dobroho Dnia" }] });
    await op({ op: "create", name: "Сільпо", apply: false });
    await op({ op: "update", entityId: a.entity!.id, merchantType: "Інше" });
    const res = await op({ op: "set_merchant_type", typeWord: "аптека", merchantType: "Аптеки", onlyUntyped: true }, true);
    expect(res.typed).toEqual([]);
    expect(res.skipped.map((t) => t.name)).toEqual(["Doctor"]);
    const all = await op({ op: "set_merchant_type", typeWord: "аптека", merchantType: "Аптеки" });
    expect(all.typed.map((t) => t.name).sort()).toEqual(["Аптека Подорожник"]);
    await op({ op: "undo", batchId: all.batchId });
    const d = await dir();
    expect(d.find((e) => e.name === "Doctor")!.merchantTypeId).toBeNull();
    expect(d.find((e) => e.name === "Аптека Подорожник")!.merchantTypeId).not.toBeNull();
  });

  it("edits the dictionary: add, rename, remove (entries lose the type), undo brings it back", async () => {
    const c = await op({ op: "create", name: "Uklon", apply: false, merchantType: "Транспорт і таксі" });
    const added = await op({ op: "merchant_types", add: [{ group: "Транспорт і таксі", name: "Таксі" }] });
    expect(added.merchantTypes.added).toEqual(["Транспорт і таксі → Таксі"]);
    await expect(op({ op: "merchant_types", add: [{ group: "транспорт і таксі", name: "таксі" }] })).rejects.toThrow(/уже є/);
    const taxi = (await types()).find((t) => t.name === "Транспорт і таксі")!;
    const renamed = await op({ op: "merchant_types", update: [{ id: taxi.id!, name: "Громадський транспорт" }] });
    expect(renamed.merchantTypes.updated[0]).toContain("Громадський транспорт");
    const removed = await op({ op: "merchant_types", remove: [taxi.id!] });
    expect(removed.typed).toEqual([{ id: c.entity!.id, name: "Uklon", from: "Транспорт і таксі → Громадський транспорт", to: null }]);
    expect((await dir())[0].merchantTypeId).toBeNull();
    await op({ op: "undo", batchId: removed.batchId });
    expect((await dir())[0].merchantTypeId).toBe(taxi.id);
    expect((await types()).find((t) => t.id === taxi.id)!.name).toBe("Громадський транспорт");
    await op({ op: "undo", batchId: renamed.batchId });
    expect((await types()).find((t) => t.id === taxi.id)!.name).toBe("Транспорт і таксі");
  });

  it("MCP: merchant_type on create, list filter, search_transactions and the spend report by group", async () => {
    const { db } = await import("@/db");
    const call = await tools();
    for (const [name, type] of [["Ресторан Дача", "Ресторани"], ["Кафе Львівська", "Кафе"], ["Епіцентр", null]] as const) {
      const p = await call("manage_payees", { op: "create", name, apply: false, ...(type ? { merchant_type: type } : {}) });
      expect(p.preview).toBe(true);
      const done = await call("manage_payees", { op: "create", name, apply: false, ...(type ? { merchant_type: type } : {}), confirmation_token: p.confirmationToken });
      expect(done.error).toBeUndefined();
    }
    for (const [payee, amount] of [["Ресторан Дача", -1000], ["Кафе Львівська", -200], ["Кафе Львівська", -300]] as const) {
      await db.execute(sql`INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source)
        VALUES (${seed.userId}, '2026-09-15', ${seed.accountId}, 'UAH', ${amount}, ${encryptField(TEST_DEK, payee)}, 'manual')`);
    }
    const list = await call("manage_payees", { op: "list", view: "entities", merchant_type: "Кафе, ресторани, бари" });
    expect(list.entities.map((e: { name: string }) => e.name).sort()).toEqual(["Кафе Львівська", "Ресторан Дача"]);
    expect(list.entities.find((e: { name: string }) => e.name === "Ресторан Дача").merchant_type).toBe("Кафе, ресторани, бари → Ресторани");
    const untyped = await call("manage_payees", { op: "list", view: "entities", merchant_type: "без типу" });
    expect(untyped.entities.map((e: { name: string }) => e.name)).toEqual(["Епіцентр"]);

    const found = await call("search_transactions", { merchant_type: "Кафе" });

    const rows = found.results as Array<{ payee: string }>;
    expect(found.filters.merchant_type.entities).toBe(1);
    expect(rows.map((r) => r.payee).sort()).toEqual(["Кафе Львівська", "Кафе Львівська"]);

    const report = await call("manage_payees", { op: "insights", months: 24, as_of: "2026-10-01", merchant_type_group_by: "group" });
    const cafes = report.byMerchantType.find((r: { type: string }) => r.type === "Кафе, ресторани, бари");
    expect(cafes).toMatchObject({ spend: 1500, transactions: 3 });
    const byPos = await call("manage_payees", { op: "insights", months: 24, as_of: "2026-10-01", merchant_type_group_by: "position", merchant_type: "Кафе, ресторани, бари" });
    expect(byPos.byMerchantType.map((r: { type: string; spend: number }) => [r.type, r.spend])).toEqual([
      ["Кафе, ресторани, бари → Ресторани", 1000],
      ["Кафе, ресторани, бари → Кафе", 500],
    ]);
  });

  it("dictionary export / import carry the merchant type", async () => {
    await op({ op: "create", name: "Ресторан Дача", apply: false, merchantType: "Ресторани" });
    const { buildDictionary, dictionaryToJson, parseDictionary, planDictionaryImport, dictionaryImportOps } = await import("@/lib/payees/dictionary");
    const d = buildDictionary(await dir(), new Date(), await types());
    expect(d.entries[0].merchantType).toEqual({ group: "Кафе, ресторани, бари", name: "Ресторани" });
    const parsed = parseDictionary(dictionaryToJson(d).replace("Ресторан Дача", "Ресторан Липки"));
    expect(parsed.entries[0].merchantType).toEqual({ group: "Кафе, ресторани, бари", name: "Ресторани" });
    const { ops, labels } = dictionaryImportOps(planDictionaryImport(parsed.entries, await dir()));
    await op({ op: "bulk", kind: "dictionary_import", ops, labels });
    const lipky = (await dir()).find((e) => e.name === "Ресторан Липки")!;
    expect((await types()).find((t) => t.id === lipky.merchantTypeId)?.name).toBe("Ресторани");
  });
});
