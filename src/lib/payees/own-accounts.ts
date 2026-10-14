/**
 * "Мої рахунки і картки" (Payee Studio P6.2, item 76 / B27): the user's own
 * accounts and cards — IBAN, the card's LAST 4 digits, bank, currency, a
 * label and whose it is (me / spouse / business). A plain reference list:
 * nothing is imported from a bank (no PrivatBank AutoClient / SMS here).
 *
 * What it changes elsewhere (read side only):
 *   - requisite mining never suggests an own IBAN / card as a merchant's
 *     requisite;
 *   - "whose card / IBAN" answers "your account" for an own one;
 *   - payments that mention an own IBAN / card (or resolve to a directory
 *     entry holding one) are TRANSFERS between own accounts: kept out of the
 *     merchant tops and clustering, like the bank's own rows;
 *   - creating an entry with a requisite from this list gets a "looks like
 *     your account" warning in the preview.
 *
 * Storage (`payee_own_accounts`): IBAN, card last 4, label and bank are
 * encrypted with the user's DEK (v1: envelope); currency and owner are plain.
 * A full card number is NEVER accepted (refused with a plain message), let
 * alone stored. Changes run through payee batches (30-day undo).
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { PayeeDirectoryError } from "./directory";
import { extractRequisites, FULL_CARD_REFUSAL, ibanChecksumOk, isFullCardNumber, maskIban } from "./requisites";
import type { PayeeExecutor } from "./scan";
import { st } from "@/lib/i18n/current";

export const OWN_ACCOUNT_OWNERS = ["me", "spouse", "business"] as const;
export type OwnAccountOwner = (typeof OWN_ACCOUNT_OWNERS)[number];
export const OWN_OWNER_LABEL: Record<OwnAccountOwner, string> = { me: "я", spouse: "дружина / чоловік", business: "бізнес" };

/** Most own accounts / cards one user may list. */
export const OWN_ACCOUNTS_MAX = 200;

export type OwnAccount = {
  id: number;
  iban: string | null;
  cardLast4: string | null;
  bank: string | null;
  label: string | null;
  currency: string | null;
  owner: OwnAccountOwner;
};

export type OwnAccountInput = {
  iban?: string | null;
  /** The card's last 4 digits, or a mask (`5168 **** **** 1234`). A full number is refused. */
  card?: string | null;
  bank?: string | null;
  label?: string | null;
  currency?: string | null;
  owner?: string | null;
};

/** Validate one row (all fields). Throws PayeeDirectoryError in plain language. */
export function normalizeOwnAccount(input: OwnAccountInput): Omit<OwnAccount, "id"> & { warnings: string[] } {
  const warnings: string[] = [];
  let iban: string | null = null;
  if (input.iban != null && input.iban.trim()) {
    iban = input.iban.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) throw new PayeeDirectoryError(st("srv.own.notIban"));
    if (!ibanChecksumOk(iban)) warnings.push(st("srv.own.ibanChecksum", { iban: maskIban(iban) }));
  }
  let cardLast4: string | null = null;
  if (input.card != null && input.card.trim()) {
    const raw = input.card.trim();
    // A full card number — never accepted, never stored.
    if (isFullCardNumber(raw, { strict: true })) throw new PayeeDirectoryError(FULL_CARD_REFUSAL());
    const last = raw.match(/(\d{4})\s*$/);
    if (!last) throw new PayeeDirectoryError(st("srv.own.cardLast4Needed"));
    cardLast4 = last[1];
  }
  if (!iban && !cardLast4) throw new PayeeDirectoryError(st("srv.own.ibanOrCard"));
  const text = (v: string | null | undefined, what: "bank" | "label") => {
    const t = (v ?? "").replace(/\s+/g, " ").trim();
    if (t.length > 60) throw new PayeeDirectoryError(what === "bank" ? st("srv.own.bankTooLong") : st("srv.own.labelTooLong"));
    return t || null;
  };
  const currency = input.currency?.trim().toUpperCase() || null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new PayeeDirectoryError(st("srv.own.currencyCode"));
  const owner = (input.owner ?? "me").trim() as OwnAccountOwner;
  if (!(OWN_ACCOUNT_OWNERS as readonly string[]).includes(owner)) throw new PayeeDirectoryError(st("srv.own.ownerValues"));
  return { iban, cardLast4, bank: text(input.bank, "bank"), label: text(input.label, "label"), currency, owner, warnings };
}

/** The owner's label in the current request's language (OWN_OWNER_LABEL is the Ukrainian data form). */
export function ownerLabel(owner: OwnAccountOwner): string {
  return owner === "spouse" ? st("srv.own.ownerSpouse") : owner === "business" ? st("srv.own.ownerBusiness") : st("srv.own.ownerMe");
}

/** Masked one-line description: "Mono black · •••• 1234 · monobank · UAH (я)". */
export function describeOwnAccount(a: Pick<OwnAccount, "iban" | "cardLast4" | "bank" | "label" | "currency" | "owner">): string {
  const parts = [a.label, a.iban ? maskIban(a.iban) : null, a.cardLast4 ? `•••• ${a.cardLast4}` : null, a.bank, a.currency].filter(Boolean);
  return `${parts.join(" · ")} (${ownerLabel(a.owner)})`;
}

const dec = (dek: Buffer | null, v: unknown) => (v == null || !dek ? null : tryDecryptField(dek, String(v), "payee-own-account"));
const enc = (dek: Buffer, v: string | null) => (v == null ? null : encryptField(dek, v));

/** The user's own accounts / cards (decrypted). Empty without a DEK. */
export async function loadOwnAccounts(executor: PayeeExecutor, userId: string, dek: Buffer | null): Promise<OwnAccount[]> {
  if (!dek) return [];
  const rows = normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`SELECT id, iban, card_last4, bank, label, currency, owner FROM payee_own_accounts WHERE user_id = ${userId} ORDER BY id`),
  );
  return rows.map((r) => ({
    id: Number(r.id),
    iban: dec(dek, r.iban),
    cardLast4: dec(dek, r.card_last4),
    bank: dec(dek, r.bank),
    label: dec(dek, r.label),
    currency: r.currency == null ? null : String(r.currency),
    owner: (OWN_ACCOUNT_OWNERS as readonly string[]).includes(String(r.owner)) ? (String(r.owner) as OwnAccountOwner) : "me",
  }));
}

export async function insertOwnAccount(tx: PayeeExecutor, userId: string, dek: Buffer, a: Omit<OwnAccount, "id">): Promise<number> {
  const rows = normalizeDbRows<{ id: unknown }>(
    await tx.execute(sql`
      INSERT INTO payee_own_accounts (user_id, iban, card_last4, bank, label, currency, owner)
      VALUES (${userId}, ${enc(dek, a.iban)}, ${enc(dek, a.cardLast4)}, ${enc(dek, a.bank)}, ${enc(dek, a.label)}, ${a.currency}, ${a.owner})
      RETURNING id`),
  );
  return Number(rows[0].id);
}

export async function updateOwnAccountRow(tx: PayeeExecutor, userId: string, dek: Buffer, id: number, a: Omit<OwnAccount, "id">): Promise<void> {
  await tx.execute(sql`
    UPDATE payee_own_accounts SET iban = ${enc(dek, a.iban)}, card_last4 = ${enc(dek, a.cardLast4)}, bank = ${enc(dek, a.bank)},
      label = ${enc(dek, a.label)}, currency = ${a.currency}, owner = ${a.owner}
    WHERE id = ${id} AND user_id = ${userId}`);
}

// ─── matching ───────────────────────────────────────────────────────────────

export type OwnMatcher = {
  accounts: OwnAccount[];
  /** The own account a requisite value belongs to (IBAN, or a card's last 4). */
  byValue: (kind: string, value: string) => OwnAccount | null;
  /** The own account a free text (payee / note) mentions, by IBAN or card mask. */
  inText: (text: string | null | undefined) => OwnAccount | null;
  /** The own account any of a directory entry's requisites belongs to. */
  forEntity: (e: { identifiers: ReadonlyArray<{ kind: string; value: string }> }) => OwnAccount | null;
};

export function buildOwnMatcher(accounts: readonly OwnAccount[]): OwnMatcher {
  const ibans = new Map<string, OwnAccount>();
  const cards = new Map<string, OwnAccount>();
  for (const a of accounts) {
    if (a.iban) ibans.set(a.iban, a);
    if (a.cardLast4) cards.set(a.cardLast4, a);
  }
  const byValue = (kind: string, value: string) => (kind === "iban" ? ibans.get(value.replace(/\s+/g, "").toUpperCase()) : kind === "card_last4" ? cards.get(value.slice(-4)) : undefined) ?? null;
  const memo = new Map<string, OwnAccount | null>();
  return {
    accounts: [...accounts],
    byValue,
    inText: (text) => {
      const s = String(text ?? "");
      if (!s || (!ibans.size && !cards.size)) return null;
      if (memo.has(s)) return memo.get(s)!;
      let hit: OwnAccount | null = null;
      for (const r of extractRequisites(s)) {
        hit = byValue(r.kind, r.value);
        if (hit) break;
      }
      if (memo.size < 50_000) memo.set(s, hit);
      return hit;
    },
    forEntity: (e) => {
      for (const i of e.identifiers) {
        const hit = byValue(i.kind, i.value);
        if (hit) return hit;
      }
      return null;
    },
  };
}

export const EMPTY_OWN_MATCHER: OwnMatcher = buildOwnMatcher([]);

/** The user's own accounts as a matcher (empty without a DEK). */
export async function loadOwnMatcher(executor: PayeeExecutor, userId: string, dek: Buffer | null): Promise<OwnMatcher> {
  return buildOwnMatcher(await loadOwnAccounts(executor, userId, dek));
}
