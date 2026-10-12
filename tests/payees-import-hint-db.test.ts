/**
 * Payee Studio P5e against a real Postgres: the import hint wherever a row
 * becomes a transaction.
 *   B13 — email-staged rows (service tier, no DEK when staged) get the
 *         canonical name when they are approved → bank ledger → materialized;
 *         the bank row keeps its text and the import hash is copied verbatim.
 *   B19 — SimpleFIN-style connector rows (pending → staged → transaction)
 *         are hinted at staging; simplefin_pending_transactions is never
 *         rewritten.
 *   B14 — MCP manage_transactions record / bulk record / update.
 *   B15 — MCP dictionary_export / dictionary_import (two-step).
 * Every case also checks that with the hint OFF nothing changes.
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
import { decryptField, encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { encryptStaged, decryptStaged } from "@/lib/crypto/staging-envelope";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;
type Rows<T> = { rows: T[] };

describeDb("Payee Studio P5e import hint everywhere (seeded DB)", () => {
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
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_rejections, payee_proposals, bank_transactions, staged_transactions, staged_imports, simplefin_pending_transactions RESTART IDENTITY CASCADE`);
    userId = await createTestUser();
    accountId = await createAccount({ userId, name: "Mono UAH", currency: "UAH", type: "A", isInvestment: false });
    await db.execute(sql`INSERT INTO settings (key, user_id, value) VALUES ('display_currency', ${userId}, 'UAH')`);
    const { executePayeeOp } = await import("@/lib/payees/ops");
    await executePayeeOp({ executor: db, userId, dek: TEST_DEK, actor: "web", op: { op: "create", name: "Епіцентр", type: "retail", aliases: [{ pattern: "EPITCENTR K10 KYIV 360616" }] } });
  });

  const hintOn = async (on = true) => {
    const { db } = await import("@/db");
    const { savePayeeSettings } = await import("@/lib/payees/settings");
    await savePayeeSettings(db, userId, { importHint: on });
  };
  const txPayees = async () => {
    const { db } = await import("@/db");
    const r = (await db.execute(sql`SELECT payee, import_hash FROM transactions WHERE user_id = ${userId} ORDER BY id`)) as unknown as Rows<{ payee: string; import_hash: string | null }>;
    return r.rows.map((x) => ({ payee: decryptField(TEST_DEK, x.payee), hash: x.import_hash }));
  };

  async function emailStagedToTransaction(): Promise<{ bankPayee: string | null; bankHash: string; tx: { payee: string | null; hash: string | null } }> {
    const { db } = await import("@/db");
    // Staged by the email webhook: no DEK → service tier.
    const stagedImportId = randomUUID();
    await db.execute(sql`
      INSERT INTO staged_imports (id, user_id, source, expires_at, encryption_tier, bound_account_id)
      VALUES (${stagedImportId}, ${userId}, 'email', NOW() + INTERVAL '30 days', 'service', ${accountId})`);
    await db.execute(sql`
      INSERT INTO staged_transactions (id, staged_import_id, user_id, date, amount, currency, payee, row_index, import_hash, encryption_tier)
      VALUES (${randomUUID()}, ${stagedImportId}, ${userId}, '2026-10-01', -450, 'UAH', ${encryptStaged("EPITCENTR K10 KYIV 360616")}, 0, ${"sh-" + randomUUID()}, 'service')`);
    // Approve with the DEK (web /api/import/staged/[id]/approve) → bank ledger.
    const { sendStagedRowsToBankLedger } = await import("@/lib/import/send-to-bank-ledger");
    const sent = await sendStagedRowsToBankLedger({ userId, dek: TEST_DEK, stagedImportId, skipExistingMatches: false });
    expect(sent.ok).toBe(true);
    const bank = (await db.execute(sql`SELECT id, payee, encryption_tier, import_hash FROM bank_transactions WHERE user_id = ${userId}`)) as unknown as Rows<{ id: string; payee: string; encryption_tier: string; import_hash: string }>;
    expect(bank.rows).toHaveLength(1);
    const { materializeBankRowAsTransaction } = await import("@/lib/reconcile/materialize-transaction");
    const m = await materializeBankRowAsTransaction({ userId, dek: TEST_DEK, bankTransactionId: String(bank.rows[0].id) });
    expect(m.ok).toBe(true);
    const b = bank.rows[0];
    const bankPayee = b.encryption_tier === "user" ? tryDecryptField(TEST_DEK, b.payee) : decryptStaged(b.payee);
    return { bankPayee, bankHash: b.import_hash, tx: (await txPayees())[0] };
  }

  it("B13: an email-staged row gets the canonical name when it becomes a transaction; the bank row keeps its text and hash", async () => {
    await hintOn();
    const r = await emailStagedToTransaction();
    expect(r.tx.payee).toBe("Епіцентр");
    expect(r.bankPayee).toBe("EPITCENTR K10 KYIV 360616");
    expect(r.tx.hash).toBe(r.bankHash);
  });

  it("B13: with the hint off the transaction keeps the bank's spelling", async () => {
    await hintOn(false);
    const r = await emailStagedToTransaction();
    expect(r.tx.payee).toBe("EPITCENTR K10 KYIV 360616");
  });

  it("B13: executeImport (file / connector direct import) stores the canonical name, hash over the original", async () => {
    await hintOn();
    const { executeImport } = await import("@/lib/import-pipeline");
    const { generateImportHash } = await import("@/lib/import-hash");
    const res = await executeImport([{ date: "2026-10-02", account: "Mono UAH", amount: -120, payee: "EPITCENTR K10 KYIV 360616" }], [], userId, TEST_DEK);
    expect(res.imported).toBe(1);
    const [tx] = await txPayees();
    expect(tx.payee).toBe("Епіцентр");
    expect(tx.hash).toBe(generateImportHash("2026-10-02", accountId, -120, "EPITCENTR K10 KYIV 360616"));
  });

  it("B19: SimpleFIN pending → staged → transaction is hinted at staging; the pending snapshot is not rewritten", async () => {
    await hintOn();
    const { db } = await import("@/db");
    const pendingCt = encryptField(TEST_DEK, "EPITCENTR K10 KYIV 360616");
    await db.execute(sql`
      INSERT INTO simplefin_pending_transactions (user_id, account_id, external_account_id, fit_id, date, amount, currency, payee, encryption_tier)
      VALUES (${userId}, ${accountId}, 'ext-1', 'fit-1', '2026-10-03', -99, 'UAH', ${pendingCt}, 'user')`);
    const { writeStagedImport } = await import("@/lib/import/stage-statement-file");
    const staged = await writeStagedImport(
      {
        rows: [{ date: "2026-10-03", account: "Mono UAH", amount: -99, payee: "EPITCENTR K10 KYIV 360616", currency: "UAH" }],
        errors: [],
        format: "csv",
        anchors: [],
      } as never,
      {
        userId,
        dek: TEST_DEK,
        accountId,
        fileName: "SimpleFIN — Mono",
        knobs: { skipHeaderRows: 0, skipFooterRows: 0, dateFormatOverride: null, defaultCurrency: "UAH" },
        boundAccountCurrency: "UAH",
        source: "connector",
        fileFormatOverride: "simplefin",
      } as never,
    );
    const st = (await db.execute(sql`SELECT payee, encryption_tier FROM staged_transactions WHERE staged_import_id = ${staged.stagedImportId}`)) as unknown as Rows<{ payee: string; encryption_tier: string }>;
    const stagedPayee = st.rows[0].encryption_tier === "user" ? tryDecryptField(TEST_DEK, st.rows[0].payee) : decryptStaged(st.rows[0].payee);
    expect(stagedPayee).toBe("Епіцентр");
    const { sendStagedRowsToBankLedger } = await import("@/lib/import/send-to-bank-ledger");
    expect((await sendStagedRowsToBankLedger({ userId, dek: TEST_DEK, stagedImportId: staged.stagedImportId })).ok).toBe(true);
    const bank = (await db.execute(sql`SELECT id FROM bank_transactions WHERE user_id = ${userId}`)) as unknown as Rows<{ id: string }>;
    const { materializeBankRowAsTransaction } = await import("@/lib/reconcile/materialize-transaction");
    await materializeBankRowAsTransaction({ userId, dek: TEST_DEK, bankTransactionId: String(bank.rows[0].id) });
    expect((await txPayees())[0].payee).toBe("Епіцентр");
    const pending = (await db.execute(sql`SELECT payee FROM simplefin_pending_transactions WHERE user_id = ${userId}`)) as unknown as Rows<{ payee: string }>;
    expect(pending.rows[0].payee).toBe(pendingCt); // byte-identical
  });

  it("B14: MCP record / bulk record / update use the canonical name when the hint is on", async () => {
    const call = await mcpTool(userId, TEST_DEK, "manage_transactions");
    await hintOn(false);
    await call({ op: "record", amount: -10, payee: "EPITCENTR K10 KYIV 360616", account_id: accountId, date: "2026-10-04" });
    await hintOn();
    await call({ op: "record", amount: -11, payee: "EPITCENTR K10 KYIV 360616", account_id: accountId, date: "2026-10-04" });
    await call({ op: "record", transactions: [{ amount: -12, payee: "EPITCENTR K10 KYIV 360616", account_id: accountId, date: "2026-10-05" }, { amount: -13, payee: "Кав'ярня", account_id: accountId, date: "2026-10-05" }] });
    let payees = (await txPayees()).map((t) => t.payee);
    expect(payees).toEqual(["EPITCENTR K10 KYIV 360616", "Епіцентр", "Епіцентр", "Кав'ярня"]);
    const { db } = await import("@/db");
    const first = (await db.execute(sql`SELECT id FROM transactions WHERE user_id = ${userId} ORDER BY id LIMIT 1`)) as unknown as Rows<{ id: number }>;
    await call({ op: "update", id: Number(first.rows[0].id), payee: "epitcentr k10 kyiv 360616" });
    payees = (await txPayees()).map((t) => t.payee);
    expect(payees[0]).toBe("Епіцентр");
  });

  it("B15: MCP dictionary_export / dictionary_import (preview → token → one batch)", async () => {
    const call = await mcpTool(userId, TEST_DEK);
    const exp = await call({ op: "dictionary_export" });
    expect(exp.entries).toBe(1);
    const file = JSON.parse(exp.content);
    // The alias carries a long digit run (a terminal / card-like number) → never exported.
    expect(file.entries[0]).toMatchObject({ name: "Епіцентр", aliases: [] });
    expect(exp.skipped).toMatchObject({ aliases: 1 });
    expect(exp.content).not.toMatch(/amount|date"|note/);

    const content = JSON.stringify({ format: "finlynq-payee-dictionary", version: 1, entries: [{ name: "Сільпо", type: "retail", aliases: ["SILPO"] }, { name: "Епіцентр", aliases: ["EPICENTR HYPERMARKET"] }] });
    const pv = await call({ op: "dictionary_import", content });
    expect(pv.counts).toMatchObject({ create: 1, merge: 1 });
    expect(pv.confirmationToken).toBeTruthy();
    const bad = await call({ op: "dictionary_import", content, confirmation_token: "nope" });
    expect(bad.error).toMatch(/token invalid/);
    const done = await call({ op: "dictionary_import", content, confirmation_token: pv.confirmationToken });
    expect(done.batch_id).toBeGreaterThan(0);
    const list = await call({ op: "list", view: "entities" });
    expect(list.entities.map((e: { name: string }) => e.name).sort()).toEqual(["Епіцентр", "Сільпо"]);

    // A conflict: the entry's name and alias point at two different entries → no token.
    const clash = JSON.stringify({ format: "finlynq-payee-dictionary", version: 1, entries: [{ name: "Сільпо", aliases: ["EPICENTR HYPERMARKET"] }] });
    const c = await call({ op: "dictionary_import", content: clash });
    expect(c.counts.conflict).toBe(1);
    expect(c.confirmationToken).toBeUndefined();
    const resolved = await call({ op: "dictionary_import", content: clash, resolutions: { "0": "skip" } });
    expect(resolved.counts).toMatchObject({ skip: 1, conflict: 0 });
  });
});
