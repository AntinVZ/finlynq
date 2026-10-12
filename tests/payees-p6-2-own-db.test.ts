/**
 * Payee Studio P6.2 stage 3 against a real Postgres: "Мої рахунки і картки"
 * — two-step, undoable edits; a full card number is refused; own cards and
 * IBANs are never suggested as a merchant's requisites; "whose" says "your
 * account"; transfers between own accounts stay out of the spend tops; a new
 * entry with an own requisite gets a warning. SKIPS unless DATABASE_URL
 * names a `*_test` database.
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

describeDb("Payee Studio P6.2 own accounts and cards (seeded DB)", () => {
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
  const tools = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-p6-2-own", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await t[name].handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };

  const OWN_IBAN = "UA213223130000026007233566001";
  const addTx = async (payee: string, amount: number, note: string | null = null, n = 1) => {
    const { db } = await import("@/db");
    const { encryptField } = await import("@/lib/crypto/envelope");
    for (let i = 0; i < n; i++) {
      await db.execute(sql`
        INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, note, source, import_hash)
        VALUES (${seed.userId}, ${new Date().toISOString().slice(0, 10)}, ${seed.accountId}, 'UAH', ${amount}, ${encryptField(TEST_DEK, payee)},
                ${note == null ? null : encryptField(TEST_DEK, note)}, 'import', ${"own-" + Math.random()})`);
    }
  };
  const own = async () => {
    const { db } = await import("@/db");
    return (await import("@/lib/payees/own-accounts")).loadOwnAccounts(db, seed.userId, TEST_DEK);
  };
  const addMine = () =>
    op({
      op: "own_accounts",
      add: [
        { card: "5168 **** **** 1234", bank: "monobank", label: "Mono black", currency: "uah", owner: "me" },
        { iban: OWN_IBAN, bank: "ПриватБанк", currency: "UAH", owner: "spouse" },
      ],
    });

  it("adds, edits and removes own accounts as undoable batches; a full card number is refused", async () => {
    const p = await addMine();
    expect((await op({ op: "own_accounts", add: [{ card: "5678" }] }, true)).ownAccounts.added).toHaveLength(1);
    expect((await op({ op: "own_accounts", add: [{ card: "1234" }] }, true)).warnings.join(" ")).toMatch(/уже є у списку/);
    expect(p.ownAccounts.added).toHaveLength(2);
    const list = await own();
    expect(list.map((a) => a.cardLast4 ?? a.iban)).toEqual(["1234", OWN_IBAN]);
    expect(list[0]).toMatchObject({ bank: "monobank", currency: "UAH", owner: "me" });
    await expect(op({ op: "own_accounts", add: [{ card: "4149 4393 1234 5678" }] })).rejects.toThrow(/Повний номер картки/);
    await expect(op({ op: "own_accounts", add: [{ card: "4149439312345678" }] })).rejects.toThrow(/Повний номер картки/);
    const { db } = await import("@/db");
    const raw = (await db.execute(sql`SELECT iban, card_last4, bank FROM payee_own_accounts WHERE user_id = ${seed.userId}`)) as unknown as { rows: Array<Record<string, string | null>> };
    expect(JSON.stringify(raw.rows)).not.toContain("1234");
    expect(JSON.stringify(raw.rows)).not.toContain("monobank");
    const upd = await op({ op: "own_accounts", update: [{ id: list[0].id, owner: "business" }], remove: [list[1].id] });
    expect((await own()).map((a) => a.owner)).toEqual(["business"]);
    await op({ op: "undo", batchId: upd.batchId });
    expect((await own()).map((a) => a.owner)).toEqual(["me", "spouse"]);
    await op({ op: "undo", batchId: p.batchId });
    expect(await own()).toEqual([]);
  });

  it("an own card is never suggested by mine_identifiers; another card is", async () => {
    await addMine();
    await addTx("Переказ на картку", -500, "Переказ на картку 5168 **** **** 1234");
    await addTx("Коваль", -700, "Оплата на картку 4441 **** **** 9876");
    const { db } = await import("@/db");
    const { mineIdentifiers } = await import("@/lib/payees/mine");
    const { buildPayeeMatcher } = await import("@/lib/payees/directory");
    const r = await mineIdentifiers({ executor: db, userId: seed.userId, dek: TEST_DEK, matcher: buildPayeeMatcher([]), directory: [] });
    const masked = r.suggestions.map((s) => s.masked);
    expect(masked).toContain("•••• 9876");
    expect(masked).not.toContain("•••• 1234");
    expect(r.ownSkipped).toBe(1);
  });

  it("whose: an own card or IBAN answers «your account»", async () => {
    await addMine();
    await addTx("Переказ на картку", -500, "Переказ на картку 5168 **** **** 1234");
    const { db } = await import("@/db");
    const { findWhose } = await import("@/lib/payees/whose");
    const w = await findWhose({ executor: db, userId: seed.userId, dek: TEST_DEK, identifier: "1234" });
    expect(w!.own).toMatchObject({ owner: "me", bank: "monobank" });
    expect(w!.hints[0]).toContain("ваш");
    const i = await findWhose({ executor: db, userId: seed.userId, dek: TEST_DEK, identifier: OWN_IBAN });
    expect(i!.own).toMatchObject({ owner: "spouse" });
    const call = await tools();
    const m = await call("manage_payees", { op: "whose", identifier: "****1234" });
    expect(m.yourAccount).toContain("ваш");
  });

  it("transfers between own accounts stay out of the spend tops (like bank operations)", async () => {
    await addMine();
    await addTx(`Переказ ${OWN_IBAN}`, -90_000, null, 2);
    await addTx("Переказ на картку *1234", -50_000);
    await addTx("Сільпо", -800, null, 3);
    const { db } = await import("@/db");
    const { computePayeeInsights } = await import("@/lib/payees/insights");
    const { buildPayeeMatcher } = await import("@/lib/payees/directory");
    const { loadOwnMatcher } = await import("@/lib/payees/own-accounts");
    const ins = await computePayeeInsights({
      executor: db,
      userId: seed.userId,
      dek: TEST_DEK,
      matcher: buildPayeeMatcher([]),
      convert: (sl) => sl.reduce((n, x) => n + x.totalAmount, 0),
      currency: "UAH",
      own: await loadOwnMatcher(db, seed.userId, TEST_DEK),
    });
    const top = ins.topBySpend.map((c) => c.name);
    expect(top).toContain("Сільпо");
    expect(top.some((n) => n.includes("Переказ"))).toBe(false);
    expect(ins.totals.ownTransfers.transactions).toBe(3);
    // …and they are not merchants in the overview either.
    const { loadPayeeOverview } = await import("@/lib/payees/service");
    const o = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK });
    const g = o.groups.find((x) => x.name === "Переказ на картку *1234")!;
    expect(g.ownAccount).toContain("1234");
  });

  it("a new entry with an own card or IBAN gets «looks like your account»", async () => {
    await addMine();
    const p = await op({ op: "create", name: "Дружина", identifiers: [{ kind: "iban", value: OWN_IBAN }], apply: false }, true);
    expect(p.warnings.join(" ")).toMatch(/схоже на ваш рахунок/i);
    const q = await op({ op: "create", name: "Магазин", identifiers: [{ kind: "card_last4", value: "9999" }], apply: false }, true);
    expect(q.warnings.join(" ")).not.toMatch(/ваш рахунок/i);
  });

  it("MCP: own_accounts list and edit two-step", async () => {
    const call = await tools();
    const args = { op: "own_accounts_edit", add: [{ card: "**** 4321", bank: "monobank", owner: "me" }] };
    const p = await call("manage_payees", args);
    expect(p.preview).toBe(true);
    const done = await call("manage_payees", { ...args, confirmation_token: p.confirmationToken });
    expect(done.error).toBeUndefined();
    const list = await call("manage_payees", { op: "own_accounts" });
    expect(list.own_accounts[0]).toMatchObject({ card: "•••• 4321", bank: "monobank", owner: "me" });
    const bad = await call("manage_payees", { op: "own_accounts_edit", add: [{ card: "4149439312345678" }] });
    expect(bad.error).toMatch(/Повний номер картки/);
  });
});
