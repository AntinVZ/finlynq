/**
 * Global Merchants search (P8 stage 1, the Ctrl/Cmd+K box): one query finds
 * a directory entry by its name, an alias, a recent spelling — or by a
 * requisite: IBAN, a card's last 4 digits (or a mask), ІПН / ЄДРПОУ. A
 * requisite that is one of the user's own accounts answers "your account".
 * A requisite query also offers "whose is it" (the full transaction search,
 * run only when the person opens it). Read only; requisites are masked.
 */
import { loadDirectory, findByIdentifier, maskIdentifier } from "./directory";
import { loadOwnMatcher, describeOwnAccount } from "./own-accounts";
import { identifierQueryRefusal, parseIdentifierQuery } from "./requisites";
import { suggestPayees } from "./service";
import type { PayeeExecutor } from "./scan";
import type { PayeeType } from "./match-key";

export type MerchantSearchHit = {
  kind: "entity" | "alias" | "recent" | "requisite";
  /** What the list shows. */
  label: string;
  entityId: number | null;
  entityName: string | null;
  type: PayeeType | null;
  /** A masked requisite, the alias spelling, or a transaction count. */
  detail: string | null;
  count?: number;
};

export type MerchantSearchResult = {
  hits: MerchantSearchHit[];
  /** The query is a requisite: its masked form and strength (a card's 4 digits are weak). */
  requisite: { kind: string; masked: string; strength: "strong" | "weak" } | null;
  /** The requisite is one of the user's own accounts / cards. */
  own: string | null;
  /** Why the query was refused (a full card number), or null. */
  refusal: string | null;
};

export async function searchMerchants(opts: { executor: PayeeExecutor; userId: string; dek: Buffer | null; q: string; limit?: number }): Promise<MerchantSearchResult> {
  const q = opts.q.trim().slice(0, 200);
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50);
  const empty: MerchantSearchResult = { hits: [], requisite: null, own: null, refusal: null };
  if (!q) return empty;
  const refusal = identifierQueryRefusal(q);
  if (refusal) return { ...empty, refusal };

  const hits: MerchantSearchHit[] = [];
  const parsed = parseIdentifierQuery(q);
  let own: string | null = null;
  if (parsed && opts.dek) {
    const [directory, ownMatcher] = await Promise.all([loadDirectory(opts.executor, opts.userId, opts.dek), loadOwnMatcher(opts.executor, opts.userId, opts.dek)]);
    const ownHit = ownMatcher.byValue(parsed.kind, parsed.value);
    if (ownHit) own = describeOwnAccount(ownHit);
    for (const e of findByIdentifier(directory, q)) {
      const id = e.identifiers.find((i) => i.kind === parsed.kind && (parsed.kind === "card_last4" ? i.value === parsed.value : i.value.replace(/\s+/g, "").toUpperCase() === parsed.value)) ?? e.identifiers[0];
      hits.push({ kind: "requisite", label: e.name, entityId: e.id, entityName: e.name, type: e.type, detail: id ? maskIdentifier(id.kind, id.value) : parsed.masked });
    }
  }
  // Names: directory entries, their aliases and recent spellings (the cached suggest index).
  const names = await suggestPayees({ executor: opts.executor, userId: opts.userId, dek: opts.dek, q, limit });
  const seen = new Set(hits.map((h) => `${h.kind}:${h.entityId}`));
  for (const s of names) {
    const id = `${s.kind}:${s.entityId ?? s.value}`;
    if (s.entityId != null && seen.has(`requisite:${s.entityId}`)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({
      kind: s.kind,
      label: s.kind === "alias" ? (s.entityName ?? s.value) : s.label,
      entityId: s.entityId,
      entityName: s.entityName,
      type: s.type,
      detail: s.kind === "alias" ? s.label : null,
      ...(s.count != null ? { count: s.count } : {}),
    });
    if (hits.length >= limit) break;
  }
  return {
    hits: hits.slice(0, limit),
    requisite: parsed ? { kind: parsed.kind, masked: parsed.masked, strength: parsed.strong ? "strong" : "weak" } : null,
    own,
    refusal: null,
  };
}
