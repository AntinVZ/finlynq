/**
 * Duplicates by amount (P8 stage 11): two DIFFERENT payees that were paid
 * (or paid you) exactly the same amount on the same day, at least twice —
 * `Степаненко` and `Stepanenko O.` both getting 15 000 ₴ on the 5th of the
 * month. Usually the same counterparty under two names; sometimes the same
 * payment recorded twice. Nothing is merged here: each pair is listed with
 * its evidence and a person decides (merge, or «Різні» — remembered as an
 * HMAC of the two matching keys in `payee_pair_rejections`).
 *
 * A side is a directory entry (all its spellings) or, outside the
 * directory, one matching key. Channels, bank operations and own-account
 * transfers are left out, and so are pairs inside one entry. Read only.
 */
import { createHmac } from "crypto";
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { payeeMatchKey } from "./match-key";
import { decodeStoredPayee, spellingOf, type PayeeExecutor } from "./scan";
import type { PayeeMatcher } from "./directory";
import type { OwnMatcher } from "./own-accounts";
import { bankOperationOf, channelOf, defaultVocabulary, type PayeeVocabulary } from "./type-words";
import { guessPayeeType } from "./match-key";
import { invalidatePayeeQueue } from "./queue-cache";

export type AmountSide = { ref: string; name: string; entityId: number | null; key: string | null; person: boolean; count: number };
export type AmountPair = {
  id: string;
  a: AmountSide;
  b: AmountSide;
  /** Same day, same amount: the shared payments (newest first, at most 5). */
  matches: Array<{ date: string; amount: number; currency: string | null }>;
  shared: number;
  /** A private person on either side: never merged without a person's word. */
  needsDecision: boolean;
};

const PAGE = 5_000;
const MAX_SCAN = 200_000;
const MIN_SHARED = 2;

export function pairRejectionHash(dek: Buffer, refA: string, refB: string): string {
  const [x, y] = [refA, refB].sort();
  return createHmac("sha256", dek).update(`pair\u0000${x}\u0000${y}`).digest("hex");
}

export async function findAmountDuplicates(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  matcher: PayeeMatcher;
  own: OwnMatcher;
  vocab?: PayeeVocabulary;
  limit?: number;
}): Promise<{ pairs: AmountPair[]; total: number; truncated: boolean }> {
  const vocab = opts.vocab ?? defaultVocabulary();
  const sides = new Map<string, AmountSide>();
  // (date|amount|currency) → refs paid that day
  const events = new Map<string, Set<string>>();
  const sideOf = new Map<string, AmountSide | null>();
  let after = 0;
  let scanned = 0;
  let truncated = false;
  for (;;) {
    const page = normalizeDbRows<Record<string, unknown>>(
      await opts.executor.execute(sql`
        SELECT id, date, amount, currency, payee FROM transactions
        WHERE user_id = ${opts.userId} AND id > ${after} ORDER BY id LIMIT ${PAGE}`),
    );
    for (const r of page) {
      after = Number(r.id);
      const amount = Number(r.amount ?? 0);
      if (!amount) continue;
      const payee = decodeStoredPayee(r.payee, null, opts.dek);
      if (payee === undefined) continue;
      const spelling = spellingOf(payee);
      if (!spelling) continue;
      let side = sideOf.get(spelling);
      if (side === undefined) {
        side = null;
        if (!channelOf(spelling) && !bankOperationOf(spelling, vocab) && !opts.own.inText(spelling)) {
          const m = opts.matcher.match(spelling);
          if (m.kind === "match") {
            const ref = `e:${m.entityId}`;
            const ent = opts.matcher.entity(m.entityId);
            side = sides.get(ref) ?? { ref, name: m.name, entityId: m.entityId, key: null, person: ent?.type === "person" || ent?.type === "sole_proprietor", count: 0 };
          } else if (m.kind === "none") {
            const key = payeeMatchKey(spelling);
            if (key) {
              const ref = `k:${key}`;
              side = sides.get(ref) ?? { ref, name: spelling, entityId: null, key, person: guessPayeeType(spelling).isPerson, count: 0 };
            }
          }
          if (side) sides.set(side.ref, side);
        }
        if (sideOf.size < 50_000) sideOf.set(spelling, side);
      }
      if (!side) continue;
      side.count++;
      const date = String(r.date ?? "").slice(0, 10);
      const ev = `${date}|${amount}|${r.currency == null ? "" : String(r.currency)}`;
      let set = events.get(ev);
      if (!set) events.set(ev, (set = new Set()));
      set.add(side.ref);
    }
    scanned += page.length;
    if (page.length < PAGE) break;
    if (scanned >= MAX_SCAN) {
      truncated = true;
      break;
    }
  }

  const pairEvents = new Map<string, string[]>();
  for (const [ev, refs] of events) {
    if (refs.size < 2 || refs.size > 4) continue; // a busy day with many equal sums proves nothing
    const list = [...refs].sort();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const id = `${list[i]}\u0000${list[j]}`;
        const arr = pairEvents.get(id) ?? [];
        arr.push(ev);
        pairEvents.set(id, arr);
      }
  }

  let rejected = new Set<string>();
  if (opts.dek && pairEvents.size) {
    const rows = normalizeDbRows<{ pair_hash: string }>(
      await opts.executor.execute(sql`SELECT pair_hash FROM payee_pair_rejections WHERE user_id = ${opts.userId}`),
    );
    rejected = new Set(rows.map((r) => String(r.pair_hash)));
  }

  const pairs: AmountPair[] = [];
  for (const [id, evs] of pairEvents) {
    if (evs.length < MIN_SHARED) continue;
    const [ra, rb] = id.split("\u0000");
    if (opts.dek && rejected.has(pairRejectionHash(opts.dek, ra, rb))) continue;
    const a = sides.get(ra)!;
    const b = sides.get(rb)!;
    const matches = evs
      .map((e) => {
        const [date, amount, currency] = e.split("|");
        return { date, amount: Number(amount), currency: currency || null };
      })
      .sort((x, y) => y.date.localeCompare(x.date));
    pairs.push({ id: Buffer.from(id).toString("base64url"), a, b, matches: matches.slice(0, 5), shared: matches.length, needsDecision: a.person || b.person });
  }
  pairs.sort((x, y) => y.shared - x.shared || Math.abs(y.matches[0].amount) - Math.abs(x.matches[0].amount));
  const limit = opts.limit ?? 100;
  return { pairs: pairs.slice(0, limit), total: pairs.length, truncated };
}

/** The two side refs of a pair id, or null for an id this code didn't make. */
export function pairRefs(id: string): [string, string] | null {
  let raw: string;
  try {
    raw = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = raw.split("\u0000");
  if (parts.length !== 2 || !parts.every((p) => /^(e:\d+|k:.+)$/.test(p))) return null;
  return [parts[0], parts[1]];
}

/** «Різні»: remember that the two payees of a pair are different (or forget it with `undo`). */
export async function rejectAmountPair(executor: PayeeExecutor, userId: string, dek: Buffer, id: string, undo = false): Promise<boolean> {
  const refs = pairRefs(id);
  if (!refs) return false;
  const hash = pairRejectionHash(dek, refs[0], refs[1]);
  if (undo) await executor.execute(sql`DELETE FROM payee_pair_rejections WHERE user_id = ${userId} AND pair_hash = ${hash}`);
  else
    await executor.execute(sql`
      INSERT INTO payee_pair_rejections (user_id, pair_hash) VALUES (${userId}, ${hash})
      ON CONFLICT (user_id, pair_hash) DO NOTHING`);
  invalidatePayeeQueue(userId);
  return true;
}
