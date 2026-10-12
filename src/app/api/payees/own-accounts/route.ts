/**
 * /api/payees/own-accounts — "Мої рахунки і картки" (Payee Studio P6.2, item 76).
 *
 * GET → { ownAccounts: [{ id, iban (masked), card ("•••• 1234"), bank, label,
 *   currency, owner, description }] }. Changes go through POST /api/payees
 *   { op: "own_accounts", add?, update?, remove?, dryRun? } (preview →
 *   confirm, one undoable batch). A full card number is never accepted.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { describeOwnAccount, loadOwnAccounts } from "@/lib/payees/own-accounts";
import { maskIdentifier } from "@/lib/payees/directory";

export const GET = apiHandler({ auth: "encryption", raw: true, fallbackMessage: "Failed to load own accounts" }, async ({ userId, dek }) => {
  const list = await loadOwnAccounts(db, userId, dek);
  return NextResponse.json({
    ownAccounts: list.map((a) => ({
      id: a.id,
      iban: a.iban ? maskIdentifier("iban", a.iban) : null,
      card: a.cardLast4 ? `•••• ${a.cardLast4}` : null,
      bank: a.bank,
      label: a.label,
      currency: a.currency,
      owner: a.owner,
      description: describeOwnAccount(a),
    })),
  });
});
