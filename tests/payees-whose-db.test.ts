/**
 * Payee Studio P5g against a real Postgres: "whose card did I pay?".
 * search_transactions `identifier`, MCP `manage_payees op=whose`,
 * GET /api/transactions?identifier= and /api/payees/requisites?action=whose:
 * 4 digits with two candidates, IBAN, ЄДРПОУ, a card mask in a note, a match
 * through the bank-statement row, masking, bank_transactions never written.
 * SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { bootstrapTestDb, createAccount, createTestUser, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { mcpTool } from "./helpers/payee-mcp";
import { createMockRequest, parseResponse } from "./helpers/api-test-utils";
import { encryptField } from "@/lib/crypto/envelope";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;
type Rows<T> = { rows: T[] };

const IBAN = "UA213223130000026007233566001";

describeDb("Payee Studio P5g whose card (seeded DB)", () => {
  let mono = 0;
  let privat = 0;
  let bankBefore: unknown[] = [];
  beforeAll(async () => {
    await bootstrapTestDb();
    await resetTestDb();
    const { db } = await import("@/db");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_rejections, payee_proposals, bank_transactions RESTART IDENTITY CASCADE`);
    authedUser = await createTestUser();
    mono = await createAccount({ userId: authedUser, name: "Mono", currency: "UAH", type: "A", isInvestment: false });
    privat = await createAccount({ userId: authedUser, name: "Privat", currency: "UAH", type: "A", isInvestment: false });
    const tx = async (payee: string, note: string, date: string, amount: number, account = mono, bankId: string | null = null) => {
      const r = (await db.execute(sql`
        INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, note, source, import_hash, bank_transaction_id)
        VALUES (${authedUser}, ${date}, ${account}, 'UAH', ${amount}, ${encryptField(TEST_DEK, payee)}, ${note ? encryptField(TEST_DEK, note) : ""}, 'manual', ${"h-" + randomUUID()}, ${bankId})
        RETURNING id`)) as unknown as Rows<{ id: number }>;
      return Number(r.rows[0].id);
    };
    const { executePayeeOp } = await import("@/lib/payees/ops");
    const op = (o: unknown) => executePayeeOp({ executor: db, userId: authedUser, dek: TEST_DEK, actor: "web", op: o as never });
    // Two people share a card ending 1234 (weak); a company holds an IBAN and an EDRPOU.
    await op({ op: "create", name: "Степаненко", type: "person", identifiers: [{ kind: "card_last4", value: "1234", label: "Mono" }] });
    await op({ op: "create", name: "Коваль Петро", type: "person", identifiers: [{ kind: "card_last4", value: "1234" }] });
    await op({ op: "create", name: "ТОВ Ромашка", type: "company", identifiers: [{ kind: "iban", value: IBAN }, { kind: "edrpou", value: "14360570" }] });
    await tx("Степаненко", "оренда", "2026-07-01", -12000, mono);
    await tx("Степаненко", "оренда", "2026-08-01", -12000, mono);
    await tx("Коваль Петро", "", "2026-08-15", -350, privat);
    await tx("ТОВ Ромашка", "", "2026-08-20", -900);
    await tx("Оплата послуг", "IBAN UA21 3223 1300 0002 6007 2335 6600 1, код ЄДРПОУ 14360570", "2026-08-21", -1500);
    await tx("Переказ", "на картку 5168 **** **** 9876", "2026-08-22", -400);
    await tx("Переказ", "з картки 4149 4999 1234 5678 мамі", "2026-08-23", -300);
    // A bank-statement row mentions the IBAN; the transaction made from it doesn't.
    const bankId = randomUUID();
    await db.execute(sql`
      INSERT INTO bank_transactions (id, user_id, account_id, import_hash, date, amount, currency, payee, note, encryption_tier, source)
      VALUES (${bankId}, ${authedUser}, ${mono}, ${"bh-" + randomUUID()}, '2026-09-01', -777, 'UAH', ${encryptField(TEST_DEK, "SEPA payment")}, ${encryptField(TEST_DEK, `to ${IBAN}`)}, 'user', 'import')`);
    await tx("Мама", "", "2026-09-01", -777, mono, bankId);
    bankBefore = ((await db.execute(sql`SELECT * FROM bank_transactions WHERE user_id = ${authedUser}`)) as unknown as Rows<unknown>).rows;
  }, 60_000);
  afterAll(async () => {
    const { db } = await import("@/db");
    const bankAfter = ((await db.execute(sql`SELECT * FROM bank_transactions WHERE user_id = ${authedUser}`)) as unknown as Rows<unknown>).rows;
    expect(bankAfter).toEqual(bankBefore); // read, never written
    await shutdownTestDb();
  });

  it("4 digits shared by two payees: both are candidates, with hints to tell them apart", async () => {
    const call = await mcpTool(authedUser, TEST_DEK);
    const r = await call({ op: "whose", identifier: "5168 **** 1234" });
    expect(r.query).toEqual({ kind: "card_last4", masked: "•••• 1234", strength: "weak" });
    const names = r.candidates.map((c: { payee: string }) => c.payee);
    expect(names.slice(0, 2).sort()).toEqual(["Коваль Петро", "Степаненко"]);
    const st = r.candidates.find((c: { payee: string }) => c.payee === "Степаненко");
    expect(st).toMatchObject({ inDirectory: true, transactions: 2, typicalAmount: 12000, accounts: ["Mono"], evidence: ["directory"] });
    expect(r.hints[0]).toMatch(/belong to \d payees/);
    expect(r.hints.join(" ")).toMatch(/Степаненко: 2 payments, usually 12000/);

    const search = await mcpTool(authedUser, TEST_DEK, "search_transactions");
    const s = await search({ identifier: "1234" });
    expect(s.filters.identifier).toMatchObject({ kind: "card_last4", strength: "weak" });
    expect(s.filters.identifier.entities.map((e: { name: string }) => e.name).sort()).toEqual(["Коваль Петро", "Степаненко"]);
    expect(s.results.map((x: { payee: string; matched_via: string }) => `${x.payee}|${x.matched_via}`).sort()).toEqual([
      "Коваль Петро|directory",
      "Степаненко|directory",
      "Степаненко|directory",
    ]);
  });

  it("by IBAN: the holder through the directory, another spelling through the note, and the bank-statement route", async () => {
    const search = await mcpTool(authedUser, TEST_DEK, "search_transactions");
    const s = await search({ identifier: "UA21 3223 1300 0002 6007 2335 6600 1" });
    expect(s.filters.identifier).toMatchObject({ kind: "iban", masked: "UA21…6001", strength: "strong", bankRowsMentioning: 1 });
    const got = s.results.map((x: { payee: string; matched_via: string }) => `${x.payee}|${x.matched_via}`).sort();
    expect(got).toEqual(["Мама|bank", "Оплата послуг|text", "ТОВ Ромашка|directory"]);
    // The returned note is masked.
    const pay = s.results.find((x: { payee: string }) => x.payee === "Оплата послуг");
    expect(pay.note).toContain("UA21…6001");
    expect(JSON.stringify(s)).not.toContain("26007233566001");
  });

  it("by ЄДРПОУ and by a card mask in a note", async () => {
    const call = await mcpTool(authedUser, TEST_DEK);
    const e = await call({ op: "whose", identifier: "14360570" });
    expect(e.candidates.map((c: { payee: string; evidence: string[] }) => [c.payee, c.evidence])).toEqual([
      ["ТОВ Ромашка", ["directory"]],
      ["Оплата послуг", ["text"]],
    ]);
    const m = await call({ op: "whose", identifier: "****9876" });
    expect(m.candidates).toEqual([expect.objectContaining({ payee: "Переказ", evidence: ["text"], transactions: 1 })]);
    expect(m.hints[0]).toMatch(/a hint, not proof/);
    // A full card number in a note is found by its last 4 and never echoed.
    const full = await call({ op: "whose", identifier: "5678" });
    expect(full.candidates[0].examples[0].text).toBe("Переказ · з картки •••• 5678 мамі");
    expect(JSON.stringify(full)).not.toContain("41494999");
  });

  it("web: GET /api/transactions?identifier= and /api/payees/requisites?action=whose|resolve", async () => {
    const txRoute = await import("@/app/api/transactions/route");
    const res = await parseResponse(await txRoute.GET(createMockRequest(`http://localhost:3000/api/transactions?identifier=${encodeURIComponent("**** 1234")}`)));
    expect(res.status).toBe(200);
    const rows = (res.data as { data: Array<{ payee: string; matchedVia: string }> }).data;
    expect(rows.map((r) => r.matchedVia)).toEqual(["directory", "directory", "directory"]);
    const bad = await parseResponse(await txRoute.GET(createMockRequest("http://localhost:3000/api/transactions?identifier=hello")));
    expect(bad.status).toBe(400);
    const req = await import("@/app/api/payees/requisites/route");
    const w = await parseResponse(await req.GET(createMockRequest(`http://localhost:3000/api/payees/requisites?action=whose&q=${encodeURIComponent(IBAN)}`)));
    expect((w.data as { candidates: Array<{ payee: string }> }).candidates.map((c) => c.payee)).toContain("ТОВ Ромашка");
    const r = await parseResponse(await req.GET(createMockRequest(`http://localhost:3000/api/payees/requisites?action=resolve&payee=${encodeURIComponent("степаненко")}`)));
    expect(r.data).toMatchObject({ entity: { name: "Степаненко" } });
  });
});
