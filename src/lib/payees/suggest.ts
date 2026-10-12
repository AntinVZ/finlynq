/**
 * Payee suggestions for the payee input boxes (Payee Studio P5a —
 * `PayeeCombobox`, GET /api/payees/suggest).
 *
 * Sources, in this order:
 *   1. directory entities — the canonical name (and its type);
 *   2. their aliases — shown as the alias, but the value offered is the
 *      CANONICAL name (an alias exists precisely so the spelling resolves
 *      there); regex aliases are never offered as text;
 *   3. recent distinct payees from the user's transactions (newest first).
 * Free text stays allowed in the box: these are hints, never a constraint.
 *
 * Built once per user from the directory and the decrypted per-user
 * transaction cache (`getUserTransactions`, one query, no N+1), then kept in
 * a small in-process cache for SUGGEST_TTL_MS — `invalidatePayeeSuggest`
 * drops it after any payee batch. Matching is accent / case / apostrophe
 * insensitive (normalizeForMatch) on the shown text, plus the payee
 * matching key (so `epitcentr` finds `Епіцентр`).
 */
import { normalizeForMatch } from "@/lib/text-normalize";
import { payeeMatchKey, transliterateToLatin, type PayeeType } from "./match-key";
import type { PayeeEntity } from "./directory";

export type PayeeSuggestion = {
  /** What goes into the payee field. */
  value: string;
  /** What the list shows. */
  label: string;
  kind: "entity" | "alias" | "recent";
  entityId: number | null;
  entityName: string | null;
  type: PayeeType | null;
  /** Transactions carrying it (recent payees only). */
  count?: number;
};

type IndexEntry = PayeeSuggestion & { norm: string; lat: string; key: string; rank: number; lastDate: string };

export type PayeeSuggestIndex = { entries: IndexEntry[]; builtAt: number };

const MAX_RECENT = 2_000;

/** Build the in-memory index. `recent` = decrypted transaction payees with dates (any order). */
export function buildSuggestIndex(directory: PayeeEntity[], recent: Array<{ payee: string; date: string }>, now = Date.now()): PayeeSuggestIndex {
  const entries: IndexEntry[] = [];
  const seenKeys = new Set<string>();
  for (const e of directory) {
    const key = payeeMatchKey(e.name);
    seenKeys.add(key);
    entries.push({ value: e.name, label: e.name, kind: "entity", entityId: e.id, entityName: e.name, type: e.type, norm: normalizeForMatch(e.name), lat: transliterateToLatin(normalizeForMatch(e.name)), key, rank: 0, lastDate: "" });
    for (const a of e.aliases) {
      if (a.mode === "regex" || a.source === "canonical" || normalizeForMatch(a.pattern) === normalizeForMatch(e.name)) continue;
      const k = payeeMatchKey(a.pattern);
      if (a.mode === "exact") seenKeys.add(k);
      entries.push({ value: e.name, label: a.pattern, kind: "alias", entityId: e.id, entityName: e.name, type: e.type, norm: normalizeForMatch(a.pattern), lat: transliterateToLatin(normalizeForMatch(a.pattern)), key: k, rank: 1, lastDate: "" });
    }
  }
  const byPayee = new Map<string, { payee: string; count: number; lastDate: string }>();
  for (const r of recent) {
    const p = (r.payee ?? "").replace(/\s+/g, " ").trim();
    if (!p || p.startsWith("v1:")) continue;
    const cur = byPayee.get(p);
    if (cur) {
      cur.count++;
      if (r.date > cur.lastDate) cur.lastDate = r.date;
    } else byPayee.set(p, { payee: p, count: 1, lastDate: r.date ?? "" });
  }
  const recentList = [...byPayee.values()].sort((a, b) => b.lastDate.localeCompare(a.lastDate) || b.count - a.count).slice(0, MAX_RECENT);
  const shownRecent = new Set<string>();
  for (const r of recentList) {
    const key = payeeMatchKey(r.payee);
    // A payee that is already a canonical name / exact alias is offered through the directory.
    if (seenKeys.has(key) || shownRecent.has(r.payee)) continue;
    shownRecent.add(r.payee);
    entries.push({ value: r.payee, label: r.payee, kind: "recent", entityId: null, entityName: null, type: null, count: r.count, norm: normalizeForMatch(r.payee), lat: transliterateToLatin(normalizeForMatch(r.payee)), key, rank: 2, lastDate: r.lastDate });
  }
  return { entries, builtAt: now };
}

/** Query the index. Empty query → recent payees first, then directory names. */
export function querySuggestIndex(index: PayeeSuggestIndex, q: string, limit = 10): PayeeSuggestion[] {
  const lim = Math.min(Math.max(limit, 1), 50);
  const needle = normalizeForMatch(q);
  const key = payeeMatchKey(q);
  const lat = transliterateToLatin(needle);
  let hits: Array<{ e: IndexEntry; score: number }>;
  if (!needle) {
    hits = index.entries.map((e) => ({ e, score: e.kind === "recent" ? 0 : e.kind === "entity" ? 1 : 9 })).filter((h) => h.score < 9);
  } else {
    hits = [];
    for (const e of index.entries) {
      let score = -1;
      if (e.norm.startsWith(needle)) score = 0;
      else if ((lat && e.lat.startsWith(lat)) || (key && e.key.startsWith(key))) score = 1;
      else if (e.norm.includes(needle)) score = 2;
      else if (lat.length >= 3 && (e.lat.includes(lat) || e.key.includes(key))) score = 3;
      if (score >= 0) hits.push({ e, score: score * 3 + e.rank });
    }
  }
  hits.sort((a, b) => a.score - b.score || b.e.lastDate.localeCompare(a.e.lastDate) || a.e.label.localeCompare(b.e.label));
  const out: PayeeSuggestion[] = [];
  const seen = new Set<string>();
  for (const { e } of hits) {
    const id = `${e.value}\u0000${e.label}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const { norm: _n, lat: _t, key: _k, rank: _r, lastDate: _l, ...pub } = e;
    out.push(pub);
    if (out.length >= lim) break;
  }
  return out;
}

// ─── per-user cache ─────────────────────────────────────────────────────────

export const SUGGEST_TTL_MS = 60_000;
const MAX_USERS = 50;
const g = globalThis as unknown as { __pfPayeeSuggest?: Map<string, PayeeSuggestIndex> };
const cache = (g.__pfPayeeSuggest ??= new Map());

export function getCachedSuggestIndex(userId: string, now = Date.now()): PayeeSuggestIndex | null {
  const hit = cache.get(userId);
  if (!hit || now - hit.builtAt > SUGGEST_TTL_MS) return null;
  return hit;
}

export function setCachedSuggestIndex(userId: string, index: PayeeSuggestIndex): void {
  if (cache.size >= MAX_USERS && !cache.has(userId)) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].builtAt - b[1].builtAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(userId, index);
}

/** Drop a user's suggestions (after any directory change / payee rewrite). */
export function invalidatePayeeSuggest(userId: string): void {
  cache.delete(userId);
}
