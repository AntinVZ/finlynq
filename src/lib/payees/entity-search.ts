/**
 * Search and order directory entries for the "Existing payee" picker (P6.1).
 *
 * Typed text matches the name and the aliases, case and apostrophes ignored
 * (`mcdonalds` finds McDonald's), then the matching keys of ./match-key.ts
 * (Latin / Cyrillic spellings meet: `мак`, `mcd` find McDonald's), then a
 * consonant skeleton of those keys as the loosest tier. Without text, the
 * entries alike to the payees being merged come first (the clustering rules
 * of ./score-keys.ts), then the rest by transaction rows.
 *
 * Pure (runs in the browser on the already-loaded directory).
 */
import { normalizeForMatch } from "@/lib/text-normalize";
import { payeeMatchKey } from "./match-key";
import { scoreKeys } from "./score-keys";
import type { PayeeVocabulary } from "./type-words";

export type SearchableEntity = { id: number; name: string; aliases?: readonly string[]; count: number };

export type RankedEntity<E extends SearchableEntity> = {
  entity: E;
  /** 4 name, 3 alias, 2 matching key, 1 consonant skeleton, 0 no text. */
  tier: number;
  /** How alike the entry is to the payees being merged (0–1). */
  similarity: number;
  /** The alias that matched, when it was not the name. */
  via: string | null;
};

const APOS = /['’ʼ‘`´]/g;
const plain = (s: string) => normalizeForMatch(s).replace(APOS, "").replace(/\s+/g, " ").trim();
/** Vowels out, so `mak` and `mkdonalds` (McDonald's) meet on `mk`. */
const skeleton = (key: string) => key.replace(/[aeiou]/g, "").replace(/(.)\1+/g, "$1");
/** Any word of `hay` starts with `needle` (multi-word needles may span words). */
const wordPrefix = (hay: string, needle: string) => hay.startsWith(needle) || hay.includes(` ${needle}`);

type Prepared = { texts: string[]; keys: string[]; skeletons: string[] };

/** Build the ranker once per directory; call it on every keystroke. */
export function entityRanker<E extends SearchableEntity>(entities: readonly E[], opts: { clusterKeys?: readonly string[]; vocab?: PayeeVocabulary } = {}) {
  const prepared = new Map<number, Prepared>();
  const prep = (e: E): Prepared => {
    let p = prepared.get(e.id);
    if (!p) {
      const all = [e.name, ...(e.aliases ?? [])];
      const keys = all.map((t) => payeeMatchKey(t)).filter(Boolean);
      p = { texts: all.map(plain), keys, skeletons: keys.map((k) => k.split(" ").map(skeleton).join(" ")) };
      prepared.set(e.id, p);
    }
    return p;
  };
  const clusterKeys = [...new Set((opts.clusterKeys ?? []).filter(Boolean))];
  const similarity = new Map<number, number>();
  for (const e of entities) {
    let best = 0;
    if (clusterKeys.length) {
      for (const k of prep(e).keys) {
        for (const c of clusterKeys) {
          const s = k === c ? 1 : (scoreKeys(c, k, opts.vocab)?.confidence ?? 0);
          if (s > best) best = s;
        }
      }
    }
    similarity.set(e.id, best);
  }

  return (query: string): Array<RankedEntity<E>> => {
    const q = plain(query);
    const qKey = q ? payeeMatchKey(query) : "";
    const qSkel = qKey ? qKey.split(" ").map(skeleton).join(" ") : "";
    const out: Array<RankedEntity<E>> = [];
    for (const e of entities) {
      const sim = similarity.get(e.id) ?? 0;
      if (!q) {
        out.push({ entity: e, tier: 0, similarity: sim, via: null });
        continue;
      }
      const p = prep(e);
      let tier = 0;
      let via: string | null = null;
      if (p.texts[0].includes(q)) tier = 4;
      else {
        const i = p.texts.findIndex((t, n) => n > 0 && t.includes(q));
        if (i > 0) {
          tier = 3;
          via = (e.aliases ?? [])[i - 1] ?? null;
        } else if (qKey && p.keys.some((k) => wordPrefix(k, qKey))) tier = 2;
        else if (qSkel.replace(/ /g, "").length >= 2 && p.skeletons.some((s) => wordPrefix(s, qSkel))) tier = 1;
      }
      if (tier) out.push({ entity: e, tier, similarity: sim, via });
    }
    return out.sort(
      (a, b) =>
        b.tier - a.tier ||
        // Without text, alike entries first; with text, they break ties.
        b.similarity - a.similarity ||
        b.entity.count - a.entity.count ||
        a.entity.name.localeCompare(b.entity.name),
    );
  };
}
