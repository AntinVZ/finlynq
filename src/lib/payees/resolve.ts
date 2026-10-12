/**
 * Resolve a counterparty query (Payee Studio P4) — for `search_transactions
 * payee_resolve`: a canonical name, any alias / stored spelling, or a
 * requisite (IBAN, EDRPOU, card last 4 …) → one directory entity, and a row
 * predicate that matches every payee resolving to it.
 *
 * When nothing in the directory matches, the query's matching key is used
 * (so "EPITCENTR K10 KYIV 360616" still finds "Epicentr" / "Епіцентр").
 * A requisite also matches rows whose payee or note contains it.
 */
import { normalizeForMatch } from "@/lib/text-normalize";
import { payeeMatchKey } from "./match-key";
import { buildPayeeMatcher, findByIdentifier, loadDirectory, maskIdentifier } from "./directory";
import { spellingOf, type PayeeExecutor } from "./scan";

export type CounterpartyResolution = {
  /** How the query was understood (safe to show: identifiers masked). */
  resolvedTo: { kind: "entity" | "identifier" | "spelling" | "ambiguous"; entityId?: number; name?: string; candidates?: string[]; via?: string };
  /** Row predicate on decrypted payee / note. */
  match: (payee: unknown, note: unknown) => boolean;
};

export async function resolveCounterparty(executor: PayeeExecutor, userId: string, dek: Buffer | null, query: string): Promise<CounterpartyResolution> {
  const q = query.trim();
  const directory = dek ? await loadDirectory(executor, userId, dek) : [];
  const matcher = buildPayeeMatcher(directory);
  const byEntity = (id: number) => (payee: unknown) => {
    const s = spellingOf(payee == null ? "" : String(payee));
    if (!s) return false;
    const m = matcher.match(s);
    return m.kind === "match" && m.entityId === id;
  };

  const ids = findByIdentifier(directory, q);
  if (ids.length === 1) {
    const e = ids[0];
    const ident = e.identifiers.find((i) => q.replace(/\s+/g, "").toUpperCase().endsWith(i.value.replace(/\s+/g, "").toUpperCase()))!;
    const needle = normalizeForMatch(ident.value);
    const isEntity = byEntity(e.id);
    return {
      resolvedTo: { kind: "identifier", entityId: e.id, name: e.name, via: `${ident.kind} ${maskIdentifier(ident.kind, ident.value)}` },
      match: (payee, note) =>
        isEntity(payee) ||
        (ident.kind !== "card_last4" && [payee, note].some((v) => v != null && normalizeForMatch(String(v)).replace(/\s+/g, "").includes(needle.replace(/\s+/g, "")))),
    };
  }

  if (ids.length > 1) {
    // Several entries share the requisite (typically a card's last 4 digits — weak): every one is a candidate.
    const set = new Set(ids.map((e) => e.id));
    return {
      resolvedTo: { kind: "ambiguous", candidates: ids.map((e) => e.name), via: "requisite shared by several payees" },
      match: (payee) => {
        const r = matcher.match(spellingOf(payee == null ? "" : String(payee)));
        return r.kind === "match" && set.has(r.entityId);
      },
    };
  }

  const m = matcher.match(spellingOf(q));
  if (m.kind === "match") return { resolvedTo: { kind: "entity", entityId: m.entityId, name: m.name, via: m.via }, match: byEntity(m.entityId) };
  if (m.kind === "ambiguous") {
    const set = new Set(m.entityIds);
    return {
      resolvedTo: { kind: "ambiguous", candidates: m.names },
      match: (payee) => {
        const r = matcher.match(spellingOf(payee == null ? "" : String(payee)));
        return (r.kind === "match" && set.has(r.entityId)) || (r.kind === "ambiguous" && r.entityIds.some((id) => set.has(id)));
      },
    };
  }
  // Not in the directory: same matching key (case, apostrophes, transliteration, terminal noise ignored).
  const key = payeeMatchKey(q);
  return {
    resolvedTo: { kind: "spelling" },
    match: (payee) => key !== "" && payeeMatchKey(payee == null ? "" : String(payee)) === key,
  };
}
