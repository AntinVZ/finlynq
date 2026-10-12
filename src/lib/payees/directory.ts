/**
 * Payee directory (Payee Studio P2): entities, aliases and identifiers.
 *
 * Storage (scripts/migrations/20261011b_payee_studio.sql): names, notes,
 * alias patterns and identifier values are v1: envelopes under the user's
 * DEK, so the whole directory is loaded and decrypted here and matched in
 * memory. `payee_aliases.key_hash` is an HMAC of the alias matching key —
 * an indexed exact lookup that never stores the key itself.
 *
 * Matching (`buildPayeeMatcher`):
 *   - exact    — `payeeMatchKey(payee) === payeeMatchKey(pattern)` (letter
 *                case, apostrophes, Latin/Cyrillic transliteration and
 *                card-terminal noise ignored). Every entity has one exact
 *                alias for its canonical name (source `canonical`).
 *   - contains — the normalized payee (or its key) contains the pattern's.
 *   - regex    — case-insensitive JS regex on the raw payee (≤ 200 chars).
 * An exact hit wins over contains / regex. Hits on two or more entities are
 * AMBIGUOUS and never resolved automatically.
 *
 * Every mutation here runs inside a payee batch (./batches.ts) so it can be
 * undone; nothing in this file opens its own transaction.
 */
import { createHmac } from "crypto";
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { normalizeForMatch } from "@/lib/text-normalize";
import { payeeMatchKey, PAYEE_TYPES, type PayeeType } from "./match-key";
import { edrpouChecksumOk, ibanChecksumOk, parseIdentifierQuery, rnokppChecksumOk } from "./requisites";
import type { PayeeExecutor } from "./scan";

export const ALIAS_MODES = ["exact", "contains", "regex"] as const;
export type AliasMode = (typeof ALIAS_MODES)[number];
export const IDENTIFIER_KINDS = ["iban", "tax_id", "edrpou", "card_last4", "crypto_wallet"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export type PayeeAlias = { id: number; entityId: number; pattern: string; mode: AliasMode; source: string; createdAt: string | null };
export type PayeeIdentifier = {
  id: number;
  entityId: number;
  kind: IdentifierKind;
  value: string;
  /** P5f: free label ("Mono black"), bank, ISO currency; primary / active flags. */
  label: string | null;
  bank: string | null;
  currency: string | null;
  isPrimary: boolean;
  isActive: boolean;
  createdAt: string | null;
};
export type IdentifierDetails = { label?: string | null; bank?: string | null; currency?: string | null; isPrimary?: boolean; isActive?: boolean };
export type PayeeEntity = {
  id: number;
  name: string;
  type: PayeeType;
  note: string | null;
  defaultCategoryId: number | null;
  /** P5c: normalized https URL, or null. */
  website: string | null;
  /** P5c: data: URI (PNG / JPEG / WebP ≤ 20 KB), or null. */
  logo: string | null;
  /** P6 (B26): `payee_merchant_types.id`, or null = no type. */
  merchantTypeId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  aliases: PayeeAlias[];
  identifiers: PayeeIdentifier[];
};

export class PayeeDirectoryError extends Error {
  constructor(message: string, public readonly code: string = "invalid") {
    super(message);
  }
}

// ─── crypto helpers ─────────────────────────────────────────────────────────

const enc = (dek: Buffer, v: string) => encryptField(dek, v) ?? "";
const dec = (dek: Buffer | null, v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v);
  if (!s.startsWith("v1:")) return s;
  if (!dek) return null;
  return tryDecryptField(dek, s, "payee-directory");
};

/** HMAC of an alias matching key. Domain-separated from `name_lookup`. */
export function aliasKeyHash(dek: Buffer, key: string): string {
  return createHmac("sha256", dek).update(`payee-alias-key\u0000${key}`, "utf8").digest("base64url");
}

const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// ─── load ───────────────────────────────────────────────────────────────────

/** Load and decrypt the user's whole directory (entities with aliases and identifiers). */
export async function loadDirectory(executor: PayeeExecutor, userId: string, dek: Buffer | null): Promise<PayeeEntity[]> {
  const ents = normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`
      SELECT id, name, type, note, default_category_id, website, logo, merchant_type_id, created_at, updated_at
      FROM payee_entities WHERE user_id = ${userId} ORDER BY id`),
  );
  const byId = new Map<number, PayeeEntity>();
  for (const r of ents) {
    const id = Number(r.id);
    byId.set(id, {
      id,
      name: dec(dek, r.name) ?? `#${id}`,
      type: (PAYEE_TYPES as readonly string[]).includes(String(r.type)) ? (String(r.type) as PayeeType) : "other",
      note: dec(dek, r.note),
      defaultCategoryId: r.default_category_id == null ? null : Number(r.default_category_id),
      website: dec(dek, r.website),
      logo: dec(dek, r.logo),
      merchantTypeId: r.merchant_type_id == null ? null : Number(r.merchant_type_id),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      aliases: [],
      identifiers: [],
    });
  }
  if (byId.size === 0) return [];
  for (const r of normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`SELECT id, entity_id, pattern, mode, source, created_at FROM payee_aliases WHERE user_id = ${userId} ORDER BY id`),
  )) {
    const e = byId.get(Number(r.entity_id));
    const pattern = dec(dek, r.pattern);
    if (!e || pattern == null) continue;
    e.aliases.push({ id: Number(r.id), entityId: e.id, pattern, mode: String(r.mode) as AliasMode, source: String(r.source), createdAt: iso(r.created_at) });
  }
  for (const r of normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`SELECT id, entity_id, kind, value, label, bank, currency, is_primary, is_active, created_at FROM payee_identifiers WHERE user_id = ${userId} ORDER BY id`),
  )) {
    const e = byId.get(Number(r.entity_id));
    const value = dec(dek, r.value);
    if (!e || value == null) continue;
    e.identifiers.push({
      id: Number(r.id),
      entityId: e.id,
      kind: String(r.kind) as IdentifierKind,
      value,
      label: dec(dek, r.label),
      bank: dec(dek, r.bank),
      currency: r.currency == null ? null : String(r.currency),
      isPrimary: r.is_primary === true || r.is_primary === "t",
      isActive: !(r.is_active === false || r.is_active === "f"),
      createdAt: iso(r.created_at),
    });
  }
  return [...byId.values()];
}

// ─── matcher ────────────────────────────────────────────────────────────────

export type PayeeMatch =
  | { kind: "match"; entityId: number; name: string; via: AliasMode; aliasId: number }
  | { kind: "ambiguous"; entityIds: number[]; names: string[] }
  | { kind: "none" };

export type PayeeMatcher = {
  match: (payee: string) => PayeeMatch;
  entity: (id: number) => PayeeEntity | undefined;
  entities: PayeeEntity[];
};

/** Compile a regex alias safely; null when invalid. */
export function compileAliasRegex(pattern: string): RegExp | null {
  if (pattern.length > 200) return null;
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return null;
  }
}

/** Build an in-memory matcher over the directory (optionally only some entities). */
export function buildPayeeMatcher(entities: PayeeEntity[], onlyIds?: ReadonlySet<number>): PayeeMatcher {
  const exact = new Map<string, Array<{ entityId: number; aliasId: number }>>();
  const loose: Array<{ entityId: number; aliasId: number; mode: AliasMode; norm: string; key: string; re: RegExp | null }> = [];
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const e of entities) {
    if (onlyIds && !onlyIds.has(e.id)) continue;
    for (const a of e.aliases) {
      if (a.mode === "exact") {
        const k = payeeMatchKey(a.pattern);
        if (!k) continue;
        const list = exact.get(k) ?? [];
        if (!list.some((x) => x.entityId === e.id)) list.push({ entityId: e.id, aliasId: a.id });
        exact.set(k, list);
      } else {
        const norm = normalizeForMatch(a.pattern);
        if (!norm) continue;
        loose.push({ entityId: e.id, aliasId: a.id, mode: a.mode, norm, key: payeeMatchKey(a.pattern), re: a.mode === "regex" ? compileAliasRegex(a.pattern) : null });
      }
    }
  }
  const cache = new Map<string, PayeeMatch>();
  const match = (payee: string): PayeeMatch => {
    const hit = cache.get(payee);
    if (hit) return hit;
    let out: PayeeMatch = { kind: "none" };
    const key = payeeMatchKey(payee);
    const ex = key ? exact.get(key) : undefined;
    if (ex && ex.length === 1) {
      out = { kind: "match", entityId: ex[0].entityId, name: byId.get(ex[0].entityId)!.name, via: "exact", aliasId: ex[0].aliasId };
    } else if (ex && ex.length > 1) {
      out = { kind: "ambiguous", entityIds: ex.map((x) => x.entityId), names: ex.map((x) => byId.get(x.entityId)!.name) };
    } else if (payee.trim() && loose.length) {
      const norm = normalizeForMatch(payee);
      const hits = new Map<number, { aliasId: number; mode: AliasMode }>();
      for (const l of loose) {
        const ok =
          l.mode === "contains"
            ? norm.includes(l.norm) || (l.key !== "" && ` ${key} `.includes(` ${l.key} `))
            : l.re != null && l.re.test(payee.slice(0, 500));
        if (ok && !hits.has(l.entityId)) hits.set(l.entityId, { aliasId: l.aliasId, mode: l.mode });
      }
      if (hits.size === 1) {
        const [[entityId, h]] = [...hits.entries()];
        out = { kind: "match", entityId, name: byId.get(entityId)!.name, via: h.mode, aliasId: h.aliasId };
      } else if (hits.size > 1) {
        out = { kind: "ambiguous", entityIds: [...hits.keys()], names: [...hits.keys()].map((id) => byId.get(id)!.name) };
      }
    }
    if (cache.size < 50_000) cache.set(payee, out);
    return out;
  };
  return { match, entity: (id) => byId.get(id), entities };
}

// ─── identifiers ────────────────────────────────────────────────────────────

/**
 * Validate and normalize an identifier value. A full card number is cut to
 * its last 4 digits here — the full number is never stored.
 */
export function normalizeIdentifier(kind: IdentifierKind, raw: string): string {
  const v = raw.trim();
  if (kind === "card_last4") {
    const digits = v.replace(/\D/g, "");
    if (digits.length < 4) throw new PayeeDirectoryError("A card identifier needs at least the last 4 digits.");
    return digits.slice(-4);
  }
  if (kind === "iban") {
    const iban = v.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) throw new PayeeDirectoryError("That doesn't look like an IBAN (e.g. UA21 3223 1300 0002 6007 2335 6600 1).");
    return iban;
  }
  if (kind === "edrpou") {
    const d = v.replace(/[\s-]+/g, "");
    if (!/^\d{8}$/.test(d)) throw new PayeeDirectoryError("An EDRPOU code is exactly 8 digits (legal entities; a ФОП has an ІПН instead).");
    return d;
  }
  if (kind === "tax_id") {
    const d = v.replace(/[\s-]+/g, "");
    if (!/^\d{10}$/.test(d)) throw new PayeeDirectoryError("A tax id (ІПН / РНОКПП) is exactly 10 digits.");
    return d;
  }
  if (!/^[A-Za-z0-9:_-]{10,120}$/.test(v)) throw new PayeeDirectoryError("A wallet address is 10–120 letters or digits.");
  return v;
}

const PERSONISH = new Set<string>(["person", "sole_proprietor"]);

/**
 * Plain-language WARNINGS for an identifier (never a refusal): a check digit
 * that doesn't add up ("looks like a typo"), or a code that doesn't fit the
 * payee's type (8 digits = a legal entity's EDRPOU, 10 = a person's / ФОП's
 * ІПН) with the type it suggests.
 */
export function identifierWarnings(kind: IdentifierKind, value: string, entityType: PayeeType): string[] {
  const out: string[] = [];
  if (kind === "tax_id") {
    if (!rnokppChecksumOk(value)) out.push(`The ІПН / РНОКПП ${maskIdentifier(kind, value)} fails its check digit — it looks like a typo.`);
    if (!PERSONISH.has(entityType)) out.push("A 10-digit ІПН belongs to a private person or a ФОП; consider changing the type to Person or Sole proprietor.");
  }
  if (kind === "edrpou") {
    if (!edrpouChecksumOk(value)) out.push(`The EDRPOU code ${value} fails its check digit — it looks like a typo.`);
    if (PERSONISH.has(entityType)) out.push("An 8-digit EDRPOU belongs to a legal entity (a ФОП has none); consider changing the type to Company.");
  }
  if (kind === "iban" && value.startsWith("UA") && !ibanChecksumOk(value)) out.push(`The IBAN ${maskIdentifier(kind, value)} fails its check digits — it looks like a typo.`);
  return out;
}

/** Which requisite kinds make sense for a payee type (the UI hides the rest). */
export function identifierKindsForType(type: PayeeType): IdentifierKind[] {
  if (PERSONISH.has(type)) return ["tax_id", "iban", "card_last4", "crypto_wallet"];
  if (type === "company" || type === "bank" || type === "government") return ["edrpou", "iban", "card_last4", "crypto_wallet"];
  return ["edrpou", "iban", "card_last4", "crypto_wallet", "tax_id"];
}

/**
 * Mask an identifier for MCP answers and logs. EDRPOU (a public company
 * code) is shown in full; everything else keeps only its edges.
 */
export function maskIdentifier(kind: IdentifierKind, value: string): string {
  if (kind === "edrpou") return value;
  if (kind === "card_last4") return `•••• ${value.slice(-4)}`;
  if (kind === "iban") return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "••••";
  if (kind === "tax_id") return value.length > 4 ? `••••${value.slice(-2)}` : "••••";
  return value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "••••";
}

/**
 * Find entities by an identifier value (any kind, normalized compare). A card
 * (last 4 digits) is a WEAK match: several entities may share the same 4
 * digits, so callers must treat more than one hit as candidates, never pick
 * one, and never use a card match for automatic renames.
 */
export function findByIdentifier(entities: PayeeEntity[], raw: string): PayeeEntity[] {
  // A card in any written form (`5168 **** 1234`, `*1234`, a full number) → its last 4 digits.
  const parsed = parseIdentifierQuery(raw);
  if (parsed?.kind === "card_last4") return entities.filter((e) => e.identifiers.some((i) => i.kind === "card_last4" && i.value === parsed.value));
  const q = raw.replace(/\s+/g, "").toUpperCase();
  if (q.length < 4) return [];
  return entities.filter((e) =>
    e.identifiers.some((i) => {
      const v = i.value.replace(/\s+/g, "").toUpperCase();
      return i.kind === "card_last4" ? q.endsWith(v) && /^\d+$/.test(q) : v === q;
    }),
  );
}

// ─── raw writes (callers wrap them in a batch) ──────────────────────────────

export function validateEntityName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) throw new PayeeDirectoryError("The payee name can't be empty.");
  if (n.length > 200) throw new PayeeDirectoryError("The payee name is too long (200 characters max).");
  if (!payeeMatchKey(n)) throw new PayeeDirectoryError("The payee name needs at least one letter or digit.");
  return n;
}

export function validateAlias(pattern: string, mode: AliasMode): string {
  const p = pattern.replace(/\s+/g, " ").trim();
  if (!p) throw new PayeeDirectoryError("An alias can't be empty.");
  if (p.length > 200) throw new PayeeDirectoryError("An alias is too long (200 characters max).");
  if (mode === "regex" && !compileAliasRegex(p)) throw new PayeeDirectoryError(`"${p}" is not a valid regular expression.`);
  if (mode === "contains" && normalizeForMatch(p).length < 3) throw new PayeeDirectoryError("A \"contains\" alias needs at least 3 characters.");
  if (mode === "exact" && !payeeMatchKey(p)) throw new PayeeDirectoryError("An exact alias needs at least one letter or digit.");
  return p;
}

export async function insertEntity(
  executor: PayeeExecutor,
  userId: string,
  dek: Buffer,
  e: { name: string; type: PayeeType; note?: string | null; defaultCategoryId?: number | null; website?: string | null; merchantTypeId?: number | null },
): Promise<number> {
  const rows = normalizeDbRows<{ id: unknown }>(
    await executor.execute(sql`
      INSERT INTO payee_entities (user_id, name, type, note, default_category_id, website, merchant_type_id)
      VALUES (${userId}, ${enc(dek, e.name)}, ${e.type}, ${e.note ? enc(dek, e.note) : null}, ${e.defaultCategoryId ?? null}, ${e.website ? enc(dek, e.website) : null}, ${e.merchantTypeId ?? null})
      RETURNING id`),
  );
  return Number(rows[0].id);
}

export async function insertAlias(
  executor: PayeeExecutor,
  userId: string,
  dek: Buffer,
  a: { entityId: number; pattern: string; mode: AliasMode; source: string },
): Promise<number> {
  const keyHash = a.mode === "exact" ? aliasKeyHash(dek, payeeMatchKey(a.pattern)) : null;
  const rows = normalizeDbRows<{ id: unknown }>(
    await executor.execute(sql`
      INSERT INTO payee_aliases (user_id, entity_id, pattern, mode, key_hash, source)
      VALUES (${userId}, ${a.entityId}, ${enc(dek, a.pattern)}, ${a.mode}, ${keyHash}, ${a.source})
      RETURNING id`),
  );
  return Number(rows[0].id);
}

export async function insertIdentifier(
  executor: PayeeExecutor,
  userId: string,
  dek: Buffer,
  i: { entityId: number; kind: IdentifierKind; value: string } & IdentifierDetails,
): Promise<number> {
  const rows = normalizeDbRows<{ id: unknown }>(
    await executor.execute(sql`
      INSERT INTO payee_identifiers (user_id, entity_id, kind, value, label, bank, currency, is_primary, is_active)
      VALUES (${userId}, ${i.entityId}, ${i.kind}, ${enc(dek, i.value)}, ${i.label ? enc(dek, i.label) : null}, ${i.bank ? enc(dek, i.bank) : null},
              ${i.currency ?? null}, ${i.isPrimary === true}, ${i.isActive !== false})
      RETURNING id`),
  );
  return Number(rows[0].id);
}

/** Update an identifier's details (not its kind / value). */
export async function updateIdentifierRow(executor: PayeeExecutor, userId: string, dek: Buffer, id: number, patch: IdentifierDetails): Promise<void> {
  const sets = [];
  if (patch.label !== undefined) sets.push(sql`label = ${patch.label ? enc(dek, patch.label) : null}`);
  if (patch.bank !== undefined) sets.push(sql`bank = ${patch.bank ? enc(dek, patch.bank) : null}`);
  if (patch.currency !== undefined) sets.push(sql`currency = ${patch.currency}`);
  if (patch.isPrimary !== undefined) sets.push(sql`is_primary = ${patch.isPrimary}`);
  if (patch.isActive !== undefined) sets.push(sql`is_active = ${patch.isActive}`);
  if (!sets.length) return;
  await executor.execute(sql`UPDATE payee_identifiers SET ${sql.join(sets, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
}

/**
 * Entities (other than `exceptEntityId`) that already own an EXACT alias with
 * the same matching key — an exact alias may belong to one entity only.
 */
export function exactAliasOwners(entities: PayeeEntity[], pattern: string, exceptEntityId?: number): PayeeEntity[] {
  const key = payeeMatchKey(pattern);
  if (!key) return [];
  return entities.filter(
    (e) => e.id !== exceptEntityId && e.aliases.some((a) => a.mode === "exact" && payeeMatchKey(a.pattern) === key),
  );
}

/** The plaintext shapes encrypted into an entity row update. */
export async function updateEntityRow(
  executor: PayeeExecutor,
  userId: string,
  dek: Buffer,
  id: number,
  patch: { name?: string; type?: PayeeType; note?: string | null; defaultCategoryId?: number | null; website?: string | null; logo?: string | null; merchantTypeId?: number | null },
): Promise<void> {
  const sets = [];
  if (patch.name !== undefined) sets.push(sql`name = ${enc(dek, patch.name)}`);
  if (patch.type !== undefined) sets.push(sql`type = ${patch.type}`);
  if (patch.note !== undefined) sets.push(sql`note = ${patch.note ? enc(dek, patch.note) : null}`);
  if (patch.defaultCategoryId !== undefined) sets.push(sql`default_category_id = ${patch.defaultCategoryId}`);
  if (patch.website !== undefined) sets.push(sql`website = ${patch.website ? enc(dek, patch.website) : null}`);
  if (patch.logo !== undefined) sets.push(sql`logo = ${patch.logo ? enc(dek, patch.logo) : null}`);
  if (patch.merchantTypeId !== undefined) sets.push(sql`merchant_type_id = ${patch.merchantTypeId}`);
  if (!sets.length) return;
  sets.push(sql`updated_at = NOW()`);
  await executor.execute(sql`UPDATE payee_entities SET ${sql.join(sets, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
}
