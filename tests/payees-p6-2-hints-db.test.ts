/**
 * Payee Studio P6.2 stage 1 against a real Postgres: bulk merchant-type
 * assignment by type word matches canonical names only (B29) with synonyms
 * (B30), lists alias-only and mixed entries as skipped, says which field
 * matched; the overview and MCP show weak / mixed hints; apply previews mark
 * case-only renames. SKIPS unless DATABASE_URL names a `*_test` database.
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

describeDb("Payee Studio P6.2 type hints (seeded DB)", () => {
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
    const server = withAutoAnnotations(new McpServer({ name: "payees-p6-2-hints", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await t[name].handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };

  const addTx = async (payee: string, n = 1) => {
    const { db } = await import("@/db");
    const { encryptField } = await import("@/lib/crypto/envelope");
    for (let i = 0; i < n; i++) {
      await db.execute(sql`
        INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source, import_hash)
        VALUES (${seed.userId}, '2026-09-15', ${seed.accountId}, 'UAH', -100, ${encryptField(TEST_DEK, payee)}, 'import', ${"p62-" + Math.random()})`);
    }
  };

  const seedPharmacies = async () => {
    await op({ op: "create", name: "Епіцентр", apply: false, aliases: [{ pattern: "Apteka Epitsentr" }] });
    await op({ op: "create", name: "Аптека Доброго Дня", apply: false });
    await op({ op: "create", name: "Pharmacy Plus", apply: false });
    await op({ op: "create", name: "AZS OKKO 51 KYIV", apply: false });
    await op({ op: "create", name: "Кафе Дача", apply: false, aliases: [{ pattern: "Hotel Dacha" }] });
  };

  it("«аптека» reaches pharmacies by name (with synonyms), never «Епіцентр» through its alias", async () => {
    await seedPharmacies();
    const body = { op: "set_merchant_type", merchantType: "Аптеки", typeWord: "аптека", onlyUntyped: true };
    const preview = await op(body, true);
    const names = preview.typed.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["Pharmacy Plus", "Аптека Доброго Дня"]);
    expect(preview.typed.find((t: { name: string }) => t.name === "Аптека Доброго Дня")?.via).toBe("назва «Аптека Доброго Дня»");
    expect(preview.skipped).toEqual([expect.objectContaining({ name: "Епіцентр", reason: expect.stringContaining("alias “Apteka Epitsentr”") })]);
    const done = await op(body);
    const d = await dir();
    expect(await typeName(d.find((e) => e.name === "Епіцентр")!.merchantTypeId)).toBeNull();
    expect(await typeName(d.find((e) => e.name === "Pharmacy Plus")!.merchantTypeId)).toBe("Аптеки");
    await op({ op: "undo", batchId: done.batchId });
    expect((await dir()).every((e) => e.merchantTypeId == null)).toBe(true);
  });

  it("«AZS OKKO» gets «Пальне (АЗС)»; a mixed entry is skipped", async () => {
    await seedPharmacies();
    const fuel = await op({ op: "set_merchant_type", merchantType: "Пальне (АЗС)", typeWord: "АЗС" }, true);
    expect(fuel.typed.map((t: { name: string }) => t.name)).toEqual(["AZS OKKO 51 KYIV"]);
    const cafe = await op({ op: "set_merchant_type", merchantType: "Кафе", typeWord: "кафе" }, true);
    expect(cafe.typed).toEqual([]);
    expect(cafe.skipped[0]).toMatchObject({ name: "Кафе Дача", reason: expect.stringContaining("змішаний") });
  });

  it("the overview and MCP show a weak hint for an alias match and mark mixed entries", async () => {
    await seedPharmacies();
    const { db } = await import("@/db");
    const { loadPayeeOverview } = await import("@/lib/payees/service");
    const o = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK });
    const by = (n: string) => o.entities.find((e) => e.name === n)!;
    expect(by("Епіцентр").merchantTypeHint).toMatchObject({ name: "Аптеки", strength: "weak", field: "alias" });
    expect(by("AZS OKKO 51 KYIV").merchantTypeHint).toMatchObject({ name: "Пальне (АЗС)", strength: "strong" });
    expect(by("Кафе Дача").merchantTypeMixed).toContain("змішаний");
    const call = await tools();
    const list = await call("manage_payees", { op: "list", view: "entities" });
    const e = list.entities.find((x: { name: string }) => x.name === "Епіцентр");
    expect(e.merchant_type_hint).toContain("WEAK");
    expect(e.merchant_type_hint).toContain("Apteka Epitsentr");
    const p = await call("manage_payees", { op: "set_merchant_type", merchant_type: "Аптеки", type_word: "аптека" });
    expect(p.merchantTypeChanges.map((c: { matched_by: string }) => c.matched_by)).toContain("назва «Аптека Доброго Дня»");
    expect(p.merchantTypeSkipped[0].name).toBe("Епіцентр");
  });

  it("an apply that only changes letter case says so in the preview", async () => {
    await addTx("PLAYSTATION NETWORK", 3);
    await addTx("PlayStation Network", 1);
    const { db } = await import("@/db");
    const { loadPayeeOverview } = await import("@/lib/payees/service");
    const o = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK });
    const g = o.groups.find((x) => x.name === "PLAYSTATION NETWORK");
    expect(g?.suggestedName).toBe("PlayStation Network");
    const p = await op({ op: "merge", into: { name: g!.suggestedName }, payees: ["PLAYSTATION NETWORK", "PlayStation Network"] }, true);
    expect(p.rows.changes).toEqual([expect.objectContaining({ from: "PLAYSTATION NETWORK", to: "PlayStation Network", count: 3, caseOnly: true })]);
  });
});
