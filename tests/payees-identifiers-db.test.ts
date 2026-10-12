/**
 * Payee Studio P5f against a real Postgres: several cards / accounts per
 * payee with details, primary / inactive, undo; the same last 4 digits on two
 * payees stays a candidate list; a full card number in a note never reaches
 * the database or an answer; signed codes are mined, bare numbers are not;
 * check-digit and type warnings; MCP identifiers / mine_identifiers.
 * SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { bootstrapTestDb, createAccount, createTestUser, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { mcpTool } from "./helpers/payee-mcp";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;
type Rows<T> = { rows: T[] };

const FULL_PAN = "4149 4999 1234 5678";

describeDb("Payee Studio P5f requisites (seeded DB)", () => {
  let userId = "";
  let accountId = 0;
  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_rejections, payee_proposals, bank_transactions RESTART IDENTITY CASCADE`);
    userId = await createTestUser();
    accountId = await createAccount({ userId, name: "Mono UAH", currency: "UAH", type: "A", isInvestment: false });
  });

  const op = async (o: unknown, dryRun = false) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId, dek: TEST_DEK, op: o as any, actor: "web", dryRun });
  };
  const dir = async () => {
    const { db } = await import("@/db");
    const { loadDirectory } = await import("@/lib/payees/directory");
    return loadDirectory(db, userId, TEST_DEK);
  };
  const tx = async (payee: string, note = "", date = "2026-09-01", amount = -500) => {
    const { db } = await import("@/db");
    await db.execute(sql`
      INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, note, source, import_hash)
      VALUES (${userId}, ${date}, ${accountId}, 'UAH', ${amount}, ${encryptField(TEST_DEK, payee)}, ${note ? encryptField(TEST_DEK, note) : ""}, 'manual', ${"h-" + randomUUID()})`);
  };

  it("keeps several cards and accounts per payee with label, bank, currency, primary and inactive; undo restores them", async () => {
    const created = await op({
      op: "create",
      name: "Степаненко",
      type: "person",
      identifiers: [
        { kind: "card_last4", value: "5168 **** **** 1234", label: "Mono black", bank: "monobank", currency: "uah", isPrimary: true },
        { kind: "card_last4", value: "4321", label: "Privat", bank: "ПриватБанк" },
        { kind: "iban", value: "UA21 3223 1300 0002 6007 2335 6600 1", label: "rent account", currency: "UAH" },
      ],
    });
    const id = created.entity!.id;
    let e = (await dir())[0];
    expect(e.identifiers.map((i) => [i.kind, i.value, i.label, i.bank, i.currency, i.isPrimary, i.isActive])).toEqual([
      ["card_last4", "1234", "Mono black", "monobank", "UAH", true, true],
      ["card_last4", "4321", "Privat", "ПриватБанк", null, false, true],
      ["iban", "UA213223130000026007233566001", "rent account", null, "UAH", false, true],
    ]);
    const { db } = await import("@/db");
    const raw = (await db.execute(sql`SELECT label, bank FROM payee_identifiers WHERE user_id = ${userId} ORDER BY id LIMIT 1`)) as unknown as Rows<{ label: string; bank: string }>;
    expect(raw.rows[0].label.startsWith("v1:")).toBe(true);
    expect(raw.rows[0].bank.startsWith("v1:")).toBe(true);

    const privat = e.identifiers.find((i) => i.value === "4321")!;
    const mono = e.identifiers.find((i) => i.value === "1234")!;
    const change = await op({ op: "identifiers", entityId: id, update: [{ id: privat.id, isPrimary: true, label: "Privat gold" }], deactivate: [mono.id] });
    e = (await dir())[0];
    expect(e.identifiers.find((i) => i.id === privat.id)).toMatchObject({ isPrimary: true, label: "Privat gold", isActive: true });
    expect(e.identifiers.find((i) => i.id === mono.id)).toMatchObject({ isPrimary: false, isActive: false });
    await op({ op: "undo", batchId: change.batchId });
    e = (await dir())[0];
    expect(e.identifiers.find((i) => i.id === privat.id)).toMatchObject({ isPrimary: false, label: "Privat" });
    expect(e.identifiers.find((i) => i.id === mono.id)).toMatchObject({ isPrimary: true, isActive: true });
  });

  it("the same last 4 digits on two payees gives candidates, never one answer, and never renames anything", async () => {
    await op({ op: "create", name: "Степаненко", type: "person", identifiers: [{ kind: "card_last4", value: "1234" }] });
    await op({ op: "create", name: "Коваль Петро", type: "person", identifiers: [{ kind: "card_last4", value: "1234" }] });
    const { findByIdentifier } = await import("@/lib/payees/directory");
    expect(findByIdentifier(await dir(), "**** 1234").map((e) => e.name).sort()).toEqual(["Коваль Петро", "Степаненко"]);
    // Import hint / autopilot never use requisites: a payee that is only the card mask stays as it is.
    const { db } = await import("@/db");
    const { savePayeeSettings } = await import("@/lib/payees/settings");
    await savePayeeSettings(db, userId, { importHint: true, autopilotEnabled: true, autopilotThreshold: 0.75 });
    const { makePayeeHinter } = await import("@/lib/payees/import-assist");
    const hint = await makePayeeHinter(db, userId, TEST_DEK);
    expect(hint("Переказ на картку **** 1234")).toBe("Переказ на картку **** 1234");
  });

  it("warns (never refuses) on a failed check digit or a code that doesn't fit the type", async () => {
    const res = await op({ op: "create", name: "ФОП Давидзон О. М.", type: "sole_proprietor", identifiers: [{ kind: "tax_id", value: "3123456780" }, { kind: "edrpou", value: "14360570" }] });
    expect(res.identifiersAdded).toHaveLength(2);
    expect(res.warnings.join(" ")).toMatch(/looks like a typo/);
    expect(res.warnings.join(" ")).toMatch(/ФОП has none/);
    await expect(op({ op: "identifiers", entityId: res.entity!.id, add: [{ kind: "tax_id", value: "14360570" }] })).rejects.toThrow(/10 digits/);
  });

  it("mines signed codes, IBANs and card masks — never bare numbers — and a full card number never reaches the database or the answer", async () => {
    await tx("Степаненко", `Переказ з картки ${FULL_PAN}`);
    await tx("Степаненко", "оренда, ІПН 3123456789");
    await tx("ТОВ Ромашка", "Оплата за договором, код ЄДРПОУ 14360570, IBAN UA21 3223 1300 0002 6007 2335 6600 1");
    await tx("Магазин", "чек 12345678, тел 3123456789"); // bare numbers: nothing
    const { db } = await import("@/db");
    await db.execute(sql`
      INSERT INTO bank_transactions (user_id, account_id, import_hash, date, amount, currency, payee, note, encryption_tier, source)
      VALUES (${userId}, ${accountId}, ${"bh-" + randomUUID()}, '2026-09-02', -100, 'UAH', ${encryptField(TEST_DEK, "Переказ на картку 5168 **** **** 9876")}, ${encryptField(TEST_DEK, "Коваль")}, 'user', 'import')`);
    const bankBefore = (await db.execute(sql`SELECT payee, note FROM bank_transactions`)) as unknown as Rows<{ payee: string; note: string }>;

    const call = await mcpTool(userId, TEST_DEK);
    const mined = await call({ op: "mine_identifiers" });
    const flat = JSON.stringify(mined);
    expect(flat).not.toContain("41494999");
    expect(flat).not.toContain("4149 4999");
    expect(flat).not.toContain("3123456789");
    const kinds = mined.suggestions.map((s: { kind: string; value: string; payee: string }) => `${s.payee}|${s.kind}|${s.value}`).sort();
    expect(kinds).toEqual([
      "Переказ на картку 5168 **** **** 9876|card_last4|•••• 9876",
      "Степаненко|card_last4|•••• 5678",
      "Степаненко|tax_id|••••89",
      "ТОВ Ромашка|edrpou|14360570",
      "ТОВ Ромашка|iban|UA21…6001",
    ]);
    expect(mined.suggestions.every((s: { payee: string }) => s.payee !== "Магазин")).toBe(true);
    const card = mined.suggestions.find((s: { kind: string; payee: string }) => s.kind === "card_last4" && s.payee === "Степаненко");
    expect(card.example).toContain("•••• 5678");
    expect(card.strength).toBe("weak");

    // Save two as drafts: the stored proposal keeps the card's last 4 digits only.
    const refs = mined.suggestions.filter((s: { payee: string }) => s.payee === "Степаненко").map((s: { ref: string }) => s.ref);
    const saved = await call({ op: "propose_identifiers", refs });
    expect(saved.saved).toHaveLength(1);
    const p = (await db.execute(sql`SELECT payload FROM payee_proposals WHERE user_id = ${userId}`)) as unknown as Rows<{ payload: string }>;
    const plain = tryDecryptField(TEST_DEK, p.rows[0].payload)!;
    expect(plain).toContain('"value":"5678"');
    expect(plain).not.toContain("41494999");
    // Nothing anywhere in the database holds the full number.
    const dump = (await db.execute(sql`SELECT payee, note FROM transactions WHERE user_id = ${userId}`)) as unknown as Rows<{ payee: string; note: string }>;
    expect(dump.rows.some((r) => (tryDecryptField(TEST_DEK, r.note) ?? "").includes(FULL_PAN))).toBe(true); // the user's own note is untouched…
    const ids = (await db.execute(sql`SELECT value FROM payee_identifiers`)) as unknown as Rows<{ value: string }>;
    expect(ids.rows.every((r) => !(tryDecryptField(TEST_DEK, r.value) ?? "").includes("4149"))).toBe(true); // …but no requisite stores it
    // The bank ledger is read, never written.
    const bankAfter = (await db.execute(sql`SELECT payee, note FROM bank_transactions`)) as unknown as Rows<{ payee: string; note: string }>;
    expect(bankAfter.rows).toEqual(bankBefore.rows);
  });

  it("a known IBAN under another payee spelling becomes a link suggestion; MCP lists requisite details masked", async () => {
    await op({ op: "create", name: "ТОВ Ромашка", type: "company", identifiers: [{ kind: "iban", value: "UA213223130000026007233566001", label: "main" }] });
    await tx("Romashka LLC payment", "IBAN UA213223130000026007233566001");
    const call = await mcpTool(userId, TEST_DEK);
    const mined = await call({ op: "mine_identifiers" });
    expect(mined.links).toEqual([expect.objectContaining({ payee: "Romashka LLC payment", looksLike: expect.objectContaining({ name: "ТОВ Ромашка" }), via: "iban UA21…6001" })]);
    const got = await call({ op: "get", entity_id: 1 });
    expect(got.entity.identifiers[0]).toMatchObject({ kind: "iban", value: "UA21…6001", label: "main" });
    const pv = await call({ op: "identifiers", entity_id: 1, add: [{ kind: "card_last4", value: "9999", label: "corporate", is_primary: true }] });
    expect(pv.preview).toBe(true);
    const done = await call({ op: "identifiers", entity_id: 1, add: [{ kind: "card_last4", value: "9999", label: "corporate", is_primary: true }], confirmation_token: pv.confirmationToken });
    expect(done.identifiersAdded).toEqual([{ kind: "card_last4", masked: "•••• 9999" }]);
  });
});
