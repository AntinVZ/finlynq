/**
 * Payee Studio P6 stage 2 against a real Postgres: the bank's own rows stay
 * out of merchant tops and the AI review pack, a type-word-only payee is not
 * proposed, and the user's vocabulary from the Studio settings reaches the
 * clustering. SKIPS unless DATABASE_URL names a `*_test` database.
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
import { payeeMatchKey } from "@/lib/payees/match-key";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("Payee Studio P6 brand and bank operations (seeded DB)", () => {
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
    await db.execute(sql`DELETE FROM settings WHERE key = 'payee_studio'`);
    seed = await seedPayeeLedger();
    const add = async (payee: string, amount: number, n: number) => {
      for (let i = 0; i < n; i++) {
        await db.execute(sql`INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source)
          VALUES (${seed.userId}, ${`2026-0${(i % 9) + 1}-10`}, ${seed.accountId}, 'UAH', ${amount}, ${encryptField(TEST_DEK, payee)}, 'import')`);
      }
    };
    await add("Комісія за переказ", -90_000, 3); // would top every spend list
    await add("Ресторан", -500, 2);
    await add("Шиномонтаж Колесо", -700, 1);
    await add("Шиномонтаж Колесо Плюс", -800, 1);
  });

  const tools = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-p6", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (args: Record<string, unknown>) => {
      const raw = (await t.manage_payees.handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };

  it("keeps bank operations out of merchant tops, counted on their own", async () => {
    const call = await tools();
    const ins = await call({ op: "insights", months: 24, limit: 5, as_of: "2026-10-01" });
    const names = ins.topBySpend.map((c: { name: string }) => c.name);
    expect(names).not.toContain("Комісія за переказ");
    expect(ins.totals.bankOperations.transactions).toBe(3);
    expect(ins.totals.bankOperations.spend).toBe(270_000);
  });

  it("the review pack proposes neither bank operations nor brandless type words", async () => {
    const call = await tools();
    const pack = await call({ op: "review" });
    const payees = pack.unrecognized.map((u: { payee: string }) => u.payee);
    expect(payees).not.toContain("Комісія за переказ");
    expect(payees).not.toContain("Ресторан");
    expect(pack.stats.bankOperations).toBe(1);
    expect(pack.stats.noBrand).toBe(1);
    const list = await call({ op: "list", view: "unrecognized", limit: 100 });
    const fee = list.payees.find((g: { name: string }) => g.name === "Комісія за переказ");
    expect(fee.bankOperation).toBe("комісія*");
  });

  it("the user's own type word from the Studio settings reaches clustering and explain", async () => {
    const call = await tools();
    const key = payeeMatchKey("Шиномонтаж Колесо");
    const before = await call({ op: "explain", a: "Шиномонтаж Колесо", b: "Колесо 12" });
    expect(before.a.brand).toMatch(/no stop words/);
    const { db } = await import("@/db");
    const { savePayeeSettings } = await import("@/lib/payees/settings");
    await savePayeeSettings(db, seed.userId, { typeWordsExtra: ["шиномонтаж"] });
    const after = await call({ op: "explain", a: "Шиномонтаж Колесо", b: "Колесо 12" });
    expect(after.a.brand).toBe(`стоп-слово прибрано: шиномонтаж; ядро: ${payeeMatchKey("Колесо")}; бренд-токен: ${payeeMatchKey("Колесо")}`);
    expect(after.verdict).toBe("clustered");
    const clusters = await call({ op: "clusters" });
    expect(clusters.clusters.some((c: { members: Array<{ key: string }> }) => c.members.some((m) => m.key === key))).toBe(true);
  });
});
