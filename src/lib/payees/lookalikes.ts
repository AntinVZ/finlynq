/**
 * Look-alikes against the directory (Payee Studio P5b).
 *
 * Clusters (./overview.ts) compare payees with each other. Once the
 * directory exists, new spellings keep arriving: `Степаненко компенсація
 * житла` next to the entry `Степаненко`, `Епіцентр К` next to `Епіцентр`.
 * This module compares every payee group that does NOT resolve to an entry
 * (no exact / contains / regex alias matches it) with every entry's canonical
 * name and exact aliases, using the same `scoreKeys` rules as clustering
 * (one-letter suffix 0.9, one name continues the other 0.75, a small edit
 * distance 0.6–0.88). Only names in the same 4-letter block are compared, so
 * it stays close to linear.
 *
 *   - A private person / sole proprietor on either side → `needsDecision`;
 *     such a suggestion is never applied automatically (nothing here applies
 *     anything — a person picks one of three actions).
 *   - A person-looking spelling is never offered to a merchant entry, and a
 *     confidently-typed merchant spelling never to a person entry.
 *   - "Different payee" answers are remembered in `payee_rejections`
 *     (HMAC of the spelling's matching key + entity id) and filtered out.
 *   - `remainder`: the spelling minus the entry's name words — what action
 *     (2) moves into a tag or a note (`компенсація житла`).
 *
 * Also reported: `unrenamed` — spellings that already RESOLVE to an entry
 * (an alias matches) but are stored under another spelling, e.g. a new
 * `Epicentr` row 60 days after a merge. Apply renames them.
 *
 * Read only; the caller supplies the overview.
 */
import { createHmac } from "crypto";
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { payeeMatchKey, type PayeeType } from "./match-key";
import { blockKeyOf, clusterable, MIN_EDGE_CONFIDENCE, scoreKeys, type PayeeGroup } from "./overview";
import type { PayeeVocabulary } from "./type-words";
import type { PayeeEntity } from "./directory";
import type { PayeeExecutor } from "./scan";
import { st } from "@/lib/i18n/current";

const PERSON_TYPES = new Set<PayeeType>(["person", "sole_proprietor"]);

export type LookalikeCandidate = {
  /** Matching key of the payee group (stable id for actions). */
  key: string;
  name: string;
  spellings: Array<{ spelling: string; count: number }>;
  count: number;
  total: number;
  lastDate: string | null;
  entity: { id: number; name: string; type: PayeeType };
  confidence: number;
  reason: string;
  /** Which alias of the entry it looks like. */
  matchedAlias: string;
  needsDecision: boolean;
  decisionReason: string | null;
  /** Spelling minus the entry's name words (for "move the rest to a tag or note"), or null. */
  remainder: string | null;
  /** Other entries it also looks like (weaker or equal). */
  alternatives: Array<{ id: number; name: string; confidence: number }>;
};

export type UnrenamedSpelling = {
  entityId: number;
  entityName: string;
  spellings: Array<{ spelling: string; count: number }>;
  /** Stored rows Apply would rename (transactions, recurring, staged). */
  rows: number;
};

export type LookalikeReport = {
  candidates: LookalikeCandidate[];
  unrenamed: UnrenamedSpelling[];
  /** Pairs hidden because someone answered "Different payee". */
  rejectedHidden: number;
};

/** HMAC of a spelling's matching key for `payee_rejections`. Domain-separated. */
export function rejectionKeyHash(dek: Buffer, key: string): string {
  return createHmac("sha256", dek).update(`payee-reject\u0000${key}`, "utf8").digest("base64url");
}

const WORD_RE = /[^\s,;:/\\|*#№()[\]{}"«»<>!?+=_~]+/g;

/**
 * The spelling without the entry's name words: `Степаненко компенсація житла`
 * minus `Степаненко` → `компенсація житла`. Words are compared by matching key
 * (so `Stepanenko` removes `Степаненко`). Null when nothing is left or nothing
 * was removed.
 */
export function payeeRemainder(spelling: string, entityNames: string[]): string | null {
  const nameKeys = new Set(entityNames.flatMap((n) => payeeMatchKey(n).split(" ")).filter(Boolean));
  const words = spelling.match(WORD_RE) ?? [];
  let removed = false;
  const kept: string[] = [];
  for (const w of words) {
    const k = payeeMatchKey(w);
    if (k && k.split(" ").every((t) => nameKeys.has(t))) {
      removed = true;
      continue;
    }
    kept.push(w);
  }
  if (!removed) return null;
  const rest = kept.join(" ").replace(/^[\s\-–—.,:;]+|[\s\-–—.,:;]+$/g, "").trim();
  return rest || null;
}

export function computeLookalikes(
  groups: readonly PayeeGroup[],
  directory: readonly PayeeEntity[],
  opts: { rejected?: (key: string, entityId: number) => boolean; minConfidence?: number; limit?: number; vocab?: PayeeVocabulary } = {},
): LookalikeReport {
  const min = Math.max(opts.minConfidence ?? MIN_EDGE_CONFIDENCE, MIN_EDGE_CONFIDENCE);
  // Exact alias keys (incl. canonical names) by block.
  const byBlock = new Map<string, Array<{ entity: PayeeEntity; key: string; pattern: string }>>();
  for (const e of directory) {
    const seen = new Set<string>();
    for (const a of e.aliases) {
      if (a.mode !== "exact") continue;
      const key = payeeMatchKey(a.pattern);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const b = blockKeyOf(key, opts.vocab);
      let list = byBlock.get(b);
      if (!list) byBlock.set(b, (list = []));
      list.push({ entity: e, key, pattern: a.pattern });
    }
  }
  const candidates: LookalikeCandidate[] = [];
  let rejectedHidden = 0;
  for (const g of groups) {
    if (!g.key || g.entityId != null || !clusterable(g)) continue;
    const pool = byBlock.get(blockKeyOf(g.key, opts.vocab));
    if (!pool) continue;
    const best = new Map<number, { confidence: number; reason: string; pattern: string; entity: PayeeEntity }>();
    for (const p of pool) {
      const entityPerson = PERSON_TYPES.has(p.entity.type);
      if (g.type.isPerson && !entityPerson && p.entity.type !== "other") continue; // a person's name never goes to a merchant
      if (entityPerson && !g.type.isPerson && g.type.type !== "other") continue; // nor a clearly-typed merchant to a person
      const s = p.key === g.key ? { confidence: 1, reason: st("srv.lookalikes.sameName") } : scoreKeys(g.key, p.key, opts.vocab);
      if (!s || s.confidence < min) continue;
      const cur = best.get(p.entity.id);
      if (!cur || s.confidence > cur.confidence) best.set(p.entity.id, { ...s, pattern: p.pattern, entity: p.entity });
    }
    let ranked = [...best.values()].sort((a, b) => b.confidence - a.confidence || a.entity.name.localeCompare(b.entity.name));
    if (opts.rejected) {
      const before = ranked.length;
      ranked = ranked.filter((r) => !opts.rejected!(g.key, r.entity.id));
      rejectedHidden += before - ranked.length;
    }
    if (!ranked.length) continue;
    const top = ranked[0];
    const entityPerson = PERSON_TYPES.has(top.entity.type);
    const needsDecision = entityPerson || g.type.isPerson;
    const names = [top.entity.name, ...top.entity.aliases.filter((a) => a.mode === "exact").map((a) => a.pattern)];
    candidates.push({
      key: g.key,
      name: g.name,
      spellings: g.spellings.map((s) => ({ spelling: s.spelling, count: s.count })),
      count: g.count,
      total: g.total,
      lastDate: g.lastDate,
      entity: { id: top.entity.id, name: top.entity.name, type: top.entity.type },
      confidence: Math.round(top.confidence * 100) / 100,
      reason: top.reason,
      matchedAlias: top.pattern,
      needsDecision,
      decisionReason: needsDecision
        ? entityPerson
          ? st(top.entity.type === "sole_proprietor" ? "srv.lookalikes.entitySoleProprietor" : "srv.lookalikes.entityPerson", { name: top.entity.name })
          : st("srv.lookalikes.looksPerson", { name: g.name, reason: g.type.reason })
        : null,
      remainder: payeeRemainder(g.name, names),
      alternatives: ranked.slice(1, 4).map((r) => ({ id: r.entity.id, name: r.entity.name, confidence: Math.round(r.confidence * 100) / 100 })),
    });
  }
  candidates.sort((a, b) => Number(a.needsDecision) - Number(b.needsDecision) || b.confidence - a.confidence || b.count - a.count);

  // Spellings that already belong to an entry but are stored under another name.
  const unrenamedMap = new Map<number, UnrenamedSpelling>();
  const nameOf = new Map(directory.map((e) => [e.id, e.name]));
  for (const g of groups) {
    if (g.entityId == null) continue;
    const canonical = nameOf.get(g.entityId);
    if (canonical == null) continue;
    for (const s of g.spellings) {
      const rewritable = (s as { rewritable?: number }).rewritable ?? s.count;
      if (s.spelling === canonical || rewritable <= 0) continue;
      let u = unrenamedMap.get(g.entityId);
      if (!u) unrenamedMap.set(g.entityId, (u = { entityId: g.entityId, entityName: canonical, spellings: [], rows: 0 }));
      u.spellings.push({ spelling: s.spelling, count: rewritable });
      u.rows += rewritable;
    }
  }
  const limit = opts.limit ?? Infinity;
  return {
    candidates: candidates.slice(0, limit),
    unrenamed: [...unrenamedMap.values()].sort((a, b) => b.rows - a.rows),
    rejectedHidden,
  };
}

// ─── rejections (payee_rejections) ──────────────────────────────────────────

export type RejectionRow = { id: number; keyHash: string; entityId: number; createdAt: string };

export async function loadRejections(executor: PayeeExecutor, userId: string): Promise<RejectionRow[]> {
  const rows = normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`SELECT id, key_hash, entity_id, created_at FROM payee_rejections WHERE user_id = ${userId} ORDER BY id DESC`),
  );
  return rows.map((r) => ({
    id: Number(r.id),
    keyHash: String(r.key_hash),
    entityId: Number(r.entity_id),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/** A predicate over (spelling key, entity id) from the stored rejections. */
export function rejectionPredicate(dek: Buffer, rows: RejectionRow[]): (key: string, entityId: number) => boolean {
  const set = new Set(rows.map((r) => `${r.keyHash}\u0000${r.entityId}`));
  const memo = new Map<string, string>();
  return (key, entityId) => {
    let h = memo.get(key);
    if (!h) memo.set(key, (h = rejectionKeyHash(dek, key)));
    return set.has(`${h}\u0000${entityId}`);
  };
}

/** Remember "Different payee". Idempotent. Returns false when the entity is not the user's. */
export async function rejectLookalike(executor: PayeeExecutor, userId: string, dek: Buffer, payee: string, entityId: number): Promise<boolean> {
  const key = payeeMatchKey(payee);
  if (!key) return false;
  const rows = normalizeDbRows(
    await executor.execute(sql`
      INSERT INTO payee_rejections (user_id, key_hash, entity_id)
      SELECT ${userId}, ${rejectionKeyHash(dek, key)}, id FROM payee_entities WHERE id = ${entityId} AND user_id = ${userId}
      ON CONFLICT (user_id, key_hash, entity_id) DO NOTHING
      RETURNING id`),
  );
  if (rows.length) return true;
  const exists = normalizeDbRows(await executor.execute(sql`SELECT 1 FROM payee_entities WHERE id = ${entityId} AND user_id = ${userId}`));
  return exists.length > 0;
}

/** Cancel rejections, by row id or by (payee, entity). Returns rows removed. */
export async function cancelRejection(
  executor: PayeeExecutor,
  userId: string,
  dek: Buffer,
  by: { id: number } | { payee: string; entityId: number },
): Promise<number> {
  const rows =
    "id" in by
      ? normalizeDbRows(await executor.execute(sql`DELETE FROM payee_rejections WHERE user_id = ${userId} AND id = ${by.id} RETURNING id`))
      : normalizeDbRows(
          await executor.execute(sql`
            DELETE FROM payee_rejections
            WHERE user_id = ${userId} AND entity_id = ${by.entityId} AND key_hash = ${rejectionKeyHash(dek, payeeMatchKey(by.payee))}
            RETURNING id`),
        );
  return rows.length;
}

/**
 * Rejections with a readable label where the spelling is still among the
 * user's payees (the table stores only a hash).
 */
export function describeRejections(
  rows: RejectionRow[],
  dek: Buffer,
  groups: readonly PayeeGroup[],
  directory: readonly PayeeEntity[],
): Array<{ id: number; entityId: number; entityName: string | null; payee: string | null; createdAt: string }> {
  const byHash = new Map<string, string>();
  for (const g of groups) if (g.key) byHash.set(rejectionKeyHash(dek, g.key), g.name);
  const names = new Map(directory.map((e) => [e.id, e.name]));
  return rows.map((r) => ({ id: r.id, entityId: r.entityId, entityName: names.get(r.entityId) ?? null, payee: byHash.get(r.keyHash) ?? null, createdAt: r.createdAt }));
}
