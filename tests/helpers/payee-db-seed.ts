/**
 * Seed a user's payees into every payee-carrying table of a real test
 * database, encrypted the way production stores them:
 *   - transactions / recurring_transactions: user DEK (v1:)
 *   - staged_transactions: service tier (sv1:, PF_STAGING_KEY)
 *   - bank_transactions: user tier (v1:) — read-only for Payee Studio
 */
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { encryptField } from "@/lib/crypto/envelope";
import { encryptStaged } from "@/lib/crypto/staging-envelope";
import { createAccount, createTestUser, TEST_DEK } from "./portfolio-fixtures";
import { expandPayeeFixtures } from "./payee-fixtures";

export type SeededPayees = { userId: string; accountId: number; txIds: number[]; stagedImportId: string };

export async function seedPayeeLedger(): Promise<SeededPayees> {
  const { db } = await import("@/db");
  const userId = await createTestUser();
  const accountId = await createAccount({ userId, name: "Mono UAH", currency: "UAH", type: "A", isInvestment: false });
  // Display currency = the ledger currency, so totals need no FX lookups.
  await db.execute(sql`INSERT INTO settings (key, user_id, value) VALUES ('display_currency', ${userId}, 'UAH')`);
  const txIds: number[] = [];
  for (const r of expandPayeeFixtures()) {
    const res = (await db.execute(sql`
      INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source, import_hash)
      VALUES (${userId}, ${r.date}, ${accountId}, 'UAH', ${r.amount}, ${encryptField(TEST_DEK, r.payee)}, 'import', ${"h-" + randomUUID()})
      RETURNING id
    `)) as unknown as { rows: Array<{ id: number }> };
    txIds.push(Number(res.rows[0].id));
  }
  await db.execute(sql`
    INSERT INTO recurring_transactions (user_id, payee, amount, frequency, account_id, next_date)
    VALUES (${userId}, ${encryptField(TEST_DEK, "Epicentr")}, -300, 'monthly', ${accountId}, '2026-11-01')
  `);
  const stagedImportId = randomUUID();
  await db.execute(sql`
    INSERT INTO staged_imports (id, user_id, source, expires_at, encryption_tier)
    VALUES (${stagedImportId}, ${userId}, 'upload', NOW() + INTERVAL '30 days', 'service')
  `);
  let i = 0;
  for (const p of ["ATB MARKET", "EPITCENTR K10 KYIV 360616"]) {
    await db.execute(sql`
      INSERT INTO staged_transactions (id, staged_import_id, user_id, date, amount, currency, payee, row_index, import_hash, encryption_tier)
      VALUES (${randomUUID()}, ${stagedImportId}, ${userId}, '2026-10-01', -50, 'UAH', ${encryptStaged(p)}, ${i++}, ${"sh-" + randomUUID()}, 'service')
    `);
  }
  await db.execute(sql`
    INSERT INTO bank_transactions (user_id, account_id, import_hash, date, amount, currency, payee, encryption_tier, source)
    VALUES (${userId}, ${accountId}, ${"bh-" + randomUUID()}, '2026-09-01', -450, 'UAH', ${encryptField(TEST_DEK, "Епіцентр")}, 'user', 'import')
  `);
  return { userId, accountId, txIds, stagedImportId };
}
