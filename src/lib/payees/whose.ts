/**
 * "Whose card did I pay?" (Payee Studio P5g) — find counterparties and
 * transactions by a requisite: an IBAN, a card in any written form
 * (`5168 **** 1234`, `****1234`, `1234`; a full card number is refused),
 * an ІПН / РНОКПП or an ЄДРПОУ.
 *
 * A transaction matches through one of three routes (`matchedVia`):
 *   1. `directory` — its payee resolves to a directory entry holding the
 *      requisite (P5f identifiers);
 *   2. `text`      — its payee or note mentions it (a card mask with those
 *      last 4 digits, the IBAN, the code);
 *   3. `bank`      — the bank-statement row it was created from (linked via
 *      transaction_bank_links / bank_transaction_id) mentions it. The bank
 *      ledger is only READ.
 * A card's last 4 digits are WEAK: every payee with them is a candidate,
 * with hints to tell them apart (typical amount, dates, accounts).
 * P6.2 (76): a requisite from "Мої рахунки і картки" answers «ваш рахунок»
 * (`own`, first hint): payments to it are transfers between own accounts. Nothing is
 * ever shown in full: requisites and example texts are masked.
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { payeeMatchKey } from "./match-key";
import { decodeStoredPayee, spellingOf, type PayeeExecutor } from "./scan";
import { extractRequisites, maskSensitiveText, parseIdentifierQuery, type IdentifierQuery } from "./requisites";
import { describeOwnAccount, loadOwnMatcher, type OwnAccount } from "./own-accounts";
import { buildPayeeMatcher, findByIdentifier, loadDirectory, type PayeeEntity, type PayeeMatcher } from "./directory";
import { st } from "@/lib/i18n/current";

export type MatchedVia = "directory" | "text" | "bank";

export type IdentifierMatcher = {
  query: IdentifierQuery;
  /** Directory entries that hold the requisite. */
  entities: Array<{ id: number; name: string; type: string; active: boolean }>;
  /** How (and whether) a decrypted transaction matches. */
  match: (row: { id: number | string; payee: unknown; note: unknown }) => MatchedVia | null;
  /** Bank-ledger rows whose text mentions the requisite. */
  bankRows: number;
  matcher: PayeeMatcher;
  directory: PayeeEntity[];
};

const BANK_SCAN_MAX = 250_000;

/** Does this text mention the requisite? */
export function textMentions(q: IdentifierQuery, text: string | null | undefined): boolean {
  const s = String(text ?? "");
  if (!s) return false;
  if (q.kind === "card_last4") return extractRequisites(s).some((r) => r.kind === "card_last4" && r.value === q.value);
  if (q.kind === "iban") return s.replace(/\s+/g, "").toUpperCase().includes(q.value);
  // ІПН / ЄДРПОУ: the digits as a whole number (signed or not — the user asked for them).
  return new RegExp(`(?<!\\d)${q.value}(?!\\d)`).test(s.replace(/[\s-]+(?=\d)/g, ""));
}

/** Build the per-row matcher (loads the directory and scans the bank ledger once). */
export async function buildIdentifierMatcher(executor: PayeeExecutor, userId: string, dek: Buffer | null, raw: string): Promise<IdentifierMatcher | null> {
  const query = parseIdentifierQuery(raw);
  if (!query) return null;
  const directory = dek ? await loadDirectory(executor, userId, dek) : [];
  const matcher = buildPayeeMatcher(directory);
  const holders = findByIdentifier(directory, query.kind === "card_last4" ? `****${query.value}` : query.value);
  const holderIds = new Set(holders.map((e) => e.id));
  // Bank-statement rows mentioning it → the transactions created from them.
  const bankIds: string[] = [];
  let after: string | null = null;
  let scanned = 0;
  for (;;) {
    const page: Array<Record<string, unknown>> = normalizeDbRows<Record<string, unknown>>(
      await executor.execute(sql`
        SELECT id::text AS id, payee, note, encryption_tier AS tier FROM bank_transactions
        WHERE user_id = ${userId} ${after != null ? sql`AND id::text > ${after}` : sql``} ORDER BY id::text LIMIT 2000`),
    );
    for (const r of page) {
      after = String(r.id);
      const tier = r.tier == null ? null : String(r.tier);
      const p = decodeStoredPayee(r.payee, tier, dek);
      const n = decodeStoredPayee(r.note, tier, dek);
      if (textMentions(query, p) || textMentions(query, n)) bankIds.push(String(r.id));
    }
    scanned += page.length;
    if (page.length < 2000 || scanned >= BANK_SCAN_MAX) break;
  }
  const viaBank = new Set<string>();
  for (let i = 0; i < bankIds.length; i += 1000) {
    const list = sql.join(bankIds.slice(i, i + 1000).map((id) => sql`${id}::uuid`), sql`, `);
    const rows = normalizeDbRows<{ id: unknown }>(
      await executor.execute(sql`
        SELECT t.id FROM transactions t WHERE t.user_id = ${userId} AND t.bank_transaction_id IN (${list})
        UNION
        SELECT l.transaction_id FROM transaction_bank_links l WHERE l.user_id = ${userId} AND l.bank_transaction_id IN (${list})`),
    );
    for (const r of rows) viaBank.add(String(r.id));
  }
  const resolved = new Map<string, number | null>();
  const entityOf = (payee: string) => {
    if (!resolved.has(payee)) {
      const m = matcher.match(payee);
      resolved.set(payee, m.kind === "match" ? m.entityId : null);
    }
    return resolved.get(payee) ?? null;
  };
  return {
    query,
    entities: holders.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      active: e.identifiers.some((i) => i.isActive && (query.kind === "card_last4" ? i.kind === "card_last4" && i.value === query.value : i.value === query.value)),
    })),
    bankRows: bankIds.length,
    matcher,
    directory,
    match: (row) => {
      const payee = spellingOf(row.payee == null ? "" : String(row.payee));
      if (holderIds.size && payee) {
        const id = entityOf(payee);
        if (id != null && holderIds.has(id)) return "directory";
      }
      if (textMentions(query, payee) || textMentions(query, row.note == null ? null : String(row.note))) return "text";
      if (viaBank.has(String(row.id))) return "bank";
      return null;
    },
  };
}

export type WhoseCandidate = {
  entity: { id: number; name: string; type: string } | null;
  payee: string;
  evidence: MatchedVia[];
  /** The directory entry holds this requisite (and whether it is still active). */
  holdsRequisite: boolean;
  transactions: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Sums by sign per account currency (currencies are never added together). */
  totals: Array<{ currency: string; paid: number; received: number }>;
  typicalAmount: number | null;
  accounts: Array<{ id: number; name: string; count: number }>;
  examples: Array<{ date: string; amount: number; currency: string; account: string; text: string; matchedVia: MatchedVia }>;
};

export type WhoseReport = {
  query: { kind: IdentifierQuery["kind"]; masked: string; strength: "strong" | "weak" };
  candidates: WhoseCandidate[];
  /** P6.2: the requisite is one of the user's own accounts / cards. */
  own: (Pick<OwnAccount, "bank" | "label" | "currency" | "owner"> & { description: string }) | null;
  bankRows: number;
  hints: string[];
  scanned: number;
  truncated: boolean;
};

const MAX_SCAN = 200_000;

/** Who carries this requisite, with the evidence. Read only; everything masked. */
export async function findWhose(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  identifier: string;
  accountNames?: Map<number, string>;
}): Promise<WhoseReport | null> {
  const { executor, userId, dek } = opts;
  const im = await buildIdentifierMatcher(executor, userId, dek, opts.identifier);
  if (!im) return null;
  type Acc = WhoseCandidate & { amounts: number[]; accountCounts: Map<number, number>; sums: Map<string, { paid: number; received: number }> };
  const accs = new Map<string, Acc>();
  for (const h of im.entities) {
    accs.set(`e:${h.id}`, {
      entity: { id: h.id, name: h.name, type: h.type },
      payee: h.name,
      evidence: ["directory"],
      holdsRequisite: true,
      transactions: 0,
      firstDate: null,
      lastDate: null,
      totals: [],
      typicalAmount: null,
      accounts: [],
      examples: [],
      amounts: [],
      accountCounts: new Map(),
      sums: new Map(),
    });
  }
  let after = 0;
  let scanned = 0;
  let truncated = false;
  for (;;) {
    const page = normalizeDbRows<Record<string, unknown>>(
      await executor.execute(sql`
        SELECT id, date, amount, currency, account_id, payee, note FROM transactions
        WHERE user_id = ${userId} AND id > ${after} ORDER BY id LIMIT 5000`),
    );
    for (const r of page) {
      after = Number(r.id);
      const payee = decodeStoredPayee(r.payee, null, dek);
      const note = decodeStoredPayee(r.note, null, dek);
      if (payee === undefined) continue;
      const via = im.match({ id: r.id as number, payee, note });
      if (!via) continue;
      const spelling = spellingOf(payee);
      const m = im.matcher.match(spelling);
      const key = m.kind === "match" ? `e:${m.entityId}` : `k:${payeeMatchKey(spelling) || spelling}`;
      let a = accs.get(key);
      if (!a) {
        const e = m.kind === "match" ? im.matcher.entity(m.entityId) : undefined;
        a = {
          entity: e ? { id: e.id, name: e.name, type: e.type } : null,
          payee: e ? e.name : spelling || "(no payee)",
          evidence: [],
          holdsRequisite: false,
          transactions: 0,
          firstDate: null,
          lastDate: null,
          totals: [],
          typicalAmount: null,
          accounts: [],
          examples: [],
          amounts: [],
          accountCounts: new Map(),
          sums: new Map(),
        };
        accs.set(key, a);
      }
      if (!a.evidence.includes(via)) a.evidence.push(via);
      a.transactions++;
      const amount = Number(r.amount ?? 0) || 0;
      const cur = String(r.currency ?? "");
      const sum = a.sums.get(cur) ?? { paid: 0, received: 0 };
      if (amount < 0) sum.paid += -amount;
      else sum.received += amount;
      a.sums.set(cur, sum);
      a.amounts.push(Math.abs(amount));
      const date = String(r.date ?? "").slice(0, 10);
      if (date && (!a.firstDate || date < a.firstDate)) a.firstDate = date;
      if (date && (!a.lastDate || date > a.lastDate)) a.lastDate = date;
      if (r.account_id != null) a.accountCounts.set(Number(r.account_id), (a.accountCounts.get(Number(r.account_id)) ?? 0) + 1);
      if (a.examples.length < 3) {
        a.examples.push({
          date,
          amount,
          currency: String(r.currency ?? ""),
          account: r.account_id == null ? "" : opts.accountNames?.get(Number(r.account_id)) ?? `#${r.account_id}`,
          text: maskSensitiveText(`${spelling}${note ? " · " + note : ""}`).slice(0, 160),
          matchedVia: via,
        });
      }
    }
    scanned += page.length;
    if (page.length < 5000) break;
    if (scanned >= MAX_SCAN) {
      truncated = true;
      break;
    }
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const candidates = [...accs.values()]
    .map(({ amounts, accountCounts, sums, ...c }) => {
      const sorted = [...amounts].sort((x, y) => x - y);
      return {
        ...c,
        holdsRequisite: c.holdsRequisite || (c.entity != null && im.entities.some((e) => e.id === c.entity!.id)),
        totals: [...sums.entries()].map(([currency, v]) => ({ currency, paid: round2(v.paid), received: round2(v.received) })),
        typicalAmount: sorted.length ? round2(sorted[Math.floor(sorted.length / 2)]) : null,
        accounts: [...accountCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id, count]) => ({ id, name: opts.accountNames?.get(id) ?? `#${id}`, count })),
      };
    })
    .sort((x, y) => Number(y.holdsRequisite) - Number(x.holdsRequisite) || y.transactions - x.transactions);
  const weak = im.query.kind === "card_last4";
  const hints: string[] = [];
  const ownHit = (await loadOwnMatcher(executor, userId, dek)).byValue(im.query.kind, im.query.value);
  if (ownHit) {
    hints.push(st("srv.whose.ownAccount", { account: describeOwnAccount(ownHit) }));
  }
  if (weak && candidates.length > 1) {
    hints.push(st("srv.whose.sharedLast4", { value: im.query.value, n: candidates.length }));
    for (const c of candidates) {
      hints.push([
        st("srv.whose.candidatePayments", { payee: c.payee, n: c.transactions }),
        c.typicalAmount != null ? st("srv.whose.candidateUsually", { amount: c.typicalAmount }) : "",
        c.firstDate ? `, ${c.firstDate} → ${c.lastDate}` : "",
        c.accounts.length ? st("srv.whose.candidateFrom", { accounts: c.accounts.map((x) => x.name).join(" / ") }) : "",
      ].join("") + ".");
    }
  } else if (weak && candidates.length === 1 && !candidates[0].holdsRequisite) {
    hints.push(st("srv.whose.last4Weak"));
  }
  return {
    query: { kind: im.query.kind, masked: im.query.masked, strength: weak ? "weak" : "strong" },
    candidates,
    own: ownHit ? { bank: ownHit.bank, label: ownHit.label, currency: ownHit.currency, owner: ownHit.owner, description: describeOwnAccount(ownHit) } : null,
    bankRows: im.bankRows,
    hints,
    scanned,
    truncated,
  };
}
