/**
 * Merchant types (Payee Studio P6, B26): WHAT a merchant is, as a two-level
 * value — group → position (`Кафе, ресторани, бари → Ресторани`). One value
 * per directory entry (`payee_entities.merchant_type_id`), separate from the
 * entity type enum (retail | service | … — unchanged). Linking a type to a
 * Finlynq category is optional and off by default.
 *
 * The dictionary (`payee_merchant_types`) is the user's own, editable list.
 * Until the user has any row, the built-in starting set below is shown
 * VIRTUALLY (no ids); the first change that needs a row writes the whole
 * starting set (`ensureMerchantTypes`), so reads never write. A type is
 * referred to by id, or by `{ group, name }` (dictionary files, MCP text
 * like "Кафе, ресторани, бари → Ресторани").
 *
 * Group and position names are a plain taxonomy (like the entity type enum),
 * stored in plaintext; payee names stay encrypted.
 *
 * Suggestions (never assigned without the user's confirmation): the type
 * words of ./type-words.ts first (`кафе` → Кафе, `ресторан` → Ресторани,
 * `аптека` → Аптеки…), then an MCC when one is known, then nothing — the
 * user picks by hand.
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { normalizeForMatch } from "@/lib/text-normalize";
import { payeeMatchKey } from "./match-key";
import { brandCoreOfKey, bankOperationOf, type MerchantTypeHint, type PayeeVocabulary } from "./type-words";
import type { PayeeExecutor } from "./scan";

export type MerchantType = {
  /** null = a built-in default not written yet (the user has no rows). */
  id: number | null;
  group: string;
  name: string;
  sort: number;
  defaultCategoryId: number | null;
};

export type MerchantTypeRef = { group: string; name: string };

/** The bank's own service rows (B25) land here. */
export const BANK_OPERATIONS_TYPE: MerchantTypeRef = { group: "Банківські операції", name: "Банківські операції" };

/** Starting set: group → positions (a group without positions is its own single position). */
export const DEFAULT_MERCHANT_TYPES: ReadonlyArray<{ group: string; names?: string[] }> = [
  { group: "Кафе, ресторани, бари", names: ["Кафе", "Ресторани", "Бари"] },
  { group: "Готелі" },
  { group: "Пальне (АЗС)" },
  { group: "Супермаркети і продукти" },
  { group: "Аптеки" },
  { group: "Транспорт і таксі" },
  { group: "Онлайн-сервіси та підписки" },
  { group: "Маркетплейси" },
  { group: "Одяг і взуття" },
  { group: "Побутова техніка" },
  { group: "Ремонт і будівництво" },
  { group: "Комунальні й зв'язок" },
  { group: "Банки і комісії" },
  { group: "Банківські операції" },
  { group: "Держава і податки" },
  { group: "Освіта і медицина" },
  { group: "Розваги" },
  { group: "Особи і ФОП" },
  { group: "Інше" },
];

export const MERCHANT_TYPE_NAME_MAX = 80;

/** The built-in starting set as rows (no ids), in display order. */
export function defaultMerchantTypes(): MerchantType[] {
  const out: MerchantType[] = [];
  for (const g of DEFAULT_MERCHANT_TYPES) {
    for (const name of g.names ?? [g.group]) out.push({ id: null, group: g.group, name, sort: out.length * 10, defaultCategoryId: null });
  }
  return out;
}

const iso = (s: string) => normalizeForMatch(s).replace(/\s+/g, " ").trim();

/** Same group and position (case, apostrophes and spacing ignored). */
export function sameMerchantType(a: MerchantTypeRef, b: MerchantTypeRef): boolean {
  return iso(a.group) === iso(b.group) && iso(a.name) === iso(b.name);
}

/** "Група → Позиція", or just the group when it has a single position named like it. */
export function formatMerchantType(t: MerchantTypeRef): string {
  return iso(t.group) === iso(t.name) ? t.group : `${t.group} → ${t.name}`;
}

/** Validate a group / position name pair. Throws a plain-language Error. */
export function validateMerchantTypeRef(ref: { group?: string | null; name?: string | null }): MerchantTypeRef {
  const group = (ref.group ?? "").replace(/\s+/g, " ").trim();
  const name = (ref.name ?? "").replace(/\s+/g, " ").trim() || group;
  if (!group) throw new Error("Вкажіть групу типу мерчанта.");
  if (group.length > MERCHANT_TYPE_NAME_MAX || name.length > MERCHANT_TYPE_NAME_MAX) throw new Error(`Назва групи чи позиції задовга (до ${MERCHANT_TYPE_NAME_MAX} символів).`);
  return { group, name };
}

/**
 * Parse a text reference: "Група → Позиція", "Група / Позиція", "Група > Позиція"
 * or a single name (resolved later against the list — a position or a group).
 */
export function parseMerchantTypeText(text: string): { group: string | null; name: string } {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.+?)\s*(?:→|->|>|\/)\s*(.+)$/);
  return m ? { group: m[1].trim(), name: m[2].trim() } : { group: null, name: t };
}

/** Find a type in a list by id, by group + position, or by a single name (a unique position, or a one-position group). */
export function findMerchantType(types: readonly MerchantType[], ref: number | string | MerchantTypeRef): MerchantType | null {
  if (typeof ref === "number") return types.find((t) => t.id === ref) ?? null;
  if (typeof ref === "object") return types.find((t) => sameMerchantType(t, ref)) ?? null;
  const p = parseMerchantTypeText(ref);
  if (p.group) return types.find((t) => sameMerchantType(t, { group: p.group!, name: p.name })) ?? null;
  const byName = types.filter((t) => iso(t.name) === iso(p.name));
  if (byName.length === 1) return byName[0];
  const byGroup = types.filter((t) => iso(t.group) === iso(p.name));
  return byGroup.length === 1 ? byGroup[0] : (byName.find((t) => iso(t.group) === iso(t.name)) ?? null);
}

/**
 * A report / search filter: matches a type whose GROUP or POSITION equals the
 * filter text ("Кафе, ресторани, бари" matches all three positions;
 * "Ресторани" only that one; "Група → Позиція" exactly). "none" = no type.
 */
export function merchantTypeFilter(filter: string): (t: MerchantTypeRef | null) => boolean {
  const f = filter.replace(/\s+/g, " ").trim();
  if (/^(?:none|без типу|-)$/i.test(f)) return (t) => t == null;
  const p = parseMerchantTypeText(f);
  if (p.group) return (t) => t != null && sameMerchantType(t, { group: p.group!, name: p.name });
  const n = iso(p.name);
  return (t) => t != null && (iso(t.group) === n || iso(t.name) === n);
}

// ─── storage ────────────────────────────────────────────────────────────────

const rowOf = (r: Record<string, unknown>): MerchantType => ({
  id: Number(r.id),
  group: String(r.group_name),
  name: String(r.name),
  sort: Number(r.sort ?? 0),
  defaultCategoryId: r.default_category_id == null ? null : Number(r.default_category_id),
});

/** The user's types (sorted), or the virtual starting set when they have none. Read only. */
export async function loadMerchantTypes(executor: PayeeExecutor, userId: string): Promise<MerchantType[]> {
  const rows = normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`
      SELECT id, group_name, name, sort, default_category_id FROM payee_merchant_types
      WHERE user_id = ${userId} ORDER BY sort, id`),
  );
  return rows.length ? rows.map(rowOf) : defaultMerchantTypes();
}

/** Write the starting set when the user has no rows yet (inside the caller's batch). Returns the stored list. */
export async function ensureMerchantTypes(tx: PayeeExecutor, userId: string): Promise<MerchantType[]> {
  const cur = await loadMerchantTypes(tx, userId);
  if (cur.every((t) => t.id != null)) return cur;
  for (const t of cur) {
    await tx.execute(sql`
      INSERT INTO payee_merchant_types (user_id, group_name, name, sort)
      VALUES (${userId}, ${t.group}, ${t.name}, ${t.sort})
      ON CONFLICT (user_id, group_name, name) DO NOTHING`);
  }
  return loadMerchantTypes(tx, userId);
}

export async function insertMerchantType(tx: PayeeExecutor, userId: string, t: MerchantTypeRef & { sort?: number; defaultCategoryId?: number | null }): Promise<number> {
  const rows = normalizeDbRows<{ id: unknown }>(
    await tx.execute(sql`
      INSERT INTO payee_merchant_types (user_id, group_name, name, sort, default_category_id)
      VALUES (${userId}, ${t.group}, ${t.name},
              ${t.sort ?? sql`COALESCE((SELECT MAX(sort) FROM payee_merchant_types WHERE user_id = ${userId}), 0) + 10`},
              ${t.defaultCategoryId ?? null})
      RETURNING id`),
  );
  return Number(rows[0].id);
}

// ─── suggestions ────────────────────────────────────────────────────────────

/** A few common MCC codes → a starting-set position (used when an MCC is known). */
export const MCC_TYPES: Record<string, MerchantTypeRef> = {
  "5812": { group: "Кафе, ресторани, бари", name: "Ресторани" },
  "5813": { group: "Кафе, ресторани, бари", name: "Бари" },
  "5814": { group: "Кафе, ресторани, бари", name: "Кафе" },
  "5462": { group: "Кафе, ресторани, бари", name: "Кафе" },
  "7011": { group: "Готелі", name: "Готелі" },
  "5541": { group: "Пальне (АЗС)", name: "Пальне (АЗС)" },
  "5542": { group: "Пальне (АЗС)", name: "Пальне (АЗС)" },
  "5411": { group: "Супермаркети і продукти", name: "Супермаркети і продукти" },
  "5499": { group: "Супермаркети і продукти", name: "Супермаркети і продукти" },
  "5912": { group: "Аптеки", name: "Аптеки" },
  "4121": { group: "Транспорт і таксі", name: "Транспорт і таксі" },
  "4111": { group: "Транспорт і таксі", name: "Транспорт і таксі" },
  "4131": { group: "Транспорт і таксі", name: "Транспорт і таксі" },
  "5651": { group: "Одяг і взуття", name: "Одяг і взуття" },
  "5661": { group: "Одяг і взуття", name: "Одяг і взуття" },
  "5691": { group: "Одяг і взуття", name: "Одяг і взуття" },
  "5722": { group: "Побутова техніка", name: "Побутова техніка" },
  "5732": { group: "Побутова техніка", name: "Побутова техніка" },
  "5200": { group: "Ремонт і будівництво", name: "Ремонт і будівництво" },
  "5211": { group: "Ремонт і будівництво", name: "Ремонт і будівництво" },
  "4814": { group: "Комунальні й зв'язок", name: "Комунальні й зв'язок" },
  "4900": { group: "Комунальні й зв'язок", name: "Комунальні й зв'язок" },
  "6011": BANK_OPERATIONS_TYPE,
  "6012": { group: "Банки і комісії", name: "Банки і комісії" },
  "9311": { group: "Держава і податки", name: "Держава і податки" },
  "8011": { group: "Освіта і медицина", name: "Освіта і медицина" },
  "8062": { group: "Освіта і медицина", name: "Освіта і медицина" },
  "8220": { group: "Освіта і медицина", name: "Освіта і медицина" },
  "7832": { group: "Розваги", name: "Розваги" },
  "7922": { group: "Розваги", name: "Розваги" },
};

/** An MCC written in a payee / note ("MCC 5812", "mcc:5411"). */
export function mccInText(text: string | null | undefined): string | null {
  const m = (text ?? "").match(/\bmcc\s*[:#]?\s*(\d{4})\b/i);
  return m ? m[1] : null;
}

export type MerchantTypeSuggestion = { type: MerchantType; reason: string; source: "type_word" | "bank_operation" | "mcc" };

/**
 * Suggest a type for a payee from its own text: a type word with a hint
 * (`ресторан` → Ресторани), a bank-operation pattern, then an MCC. Only
 * suggests types that exist in `types` (the user may have renamed or removed
 * them). Never assigns anything.
 */
export function suggestMerchantType(
  names: readonly string[],
  types: readonly MerchantType[],
  opts: { vocab?: PayeeVocabulary; mcc?: string | null } = {},
): MerchantTypeSuggestion | null {
  const pick = (ref: MerchantTypeHint | MerchantTypeRef) => findMerchantType(types, ref) ?? findMerchantType(types, ref.name);
  for (const n of names) {
    const bc = brandCoreOfKey(payeeMatchKey(n), opts.vocab);
    if (bc.hint) {
      const t = pick(bc.hint);
      if (t) return { type: t, reason: `слово-тип «${bc.removed[0]}»`, source: "type_word" };
    }
  }
  for (const n of names) {
    const op = bankOperationOf(n, opts.vocab);
    if (op) {
      const t = pick(BANK_OPERATIONS_TYPE);
      if (t) return { type: t, reason: `банківська операція («${op}»)`, source: "bank_operation" };
    }
  }
  const mcc = opts.mcc ?? names.map(mccInText).find((x) => x != null) ?? null;
  if (mcc && MCC_TYPES[mcc]) {
    const t = pick(MCC_TYPES[mcc]);
    if (t) return { type: t, reason: `MCC ${mcc}`, source: "mcc" };
  }
  return null;
}

/**
 * P6.2 (B29): the suggestion for a directory entry, by FIELD. Only the
 * canonical name gives a STRONG suggestion (one that bulk assignment may
 * use); a match found through an alias is a WEAK one with the alias named
 * in its reason (`alias “Apteka Epitsentr”: слово-тип «аптека»`), so
 * «Епіцентр» is never proposed as a pharmacy for one odd spelling. When the
 * name and the aliases point to different types the entry is MIXED and no
 * automatic assignment is offered for it.
 */
export type EntityTypeHint = MerchantTypeRef & {
  reason: string;
  source: MerchantTypeSuggestion["source"];
  strength: "strong" | "weak";
  field: "name" | "alias";
  /** The text the suggestion came from (the name, or the alias spelling). */
  matched: string;
};

export type EntityTypeHints = {
  /** The strong suggestion, else the first weak one (null when none). */
  hint: EntityTypeHint | null;
  /** Every suggestion found, name first. */
  all: EntityTypeHint[];
  /** Name / aliases suggest different types. */
  mixed: boolean;
  mixedReason: string | null;
};

export function entityMerchantTypeHints(
  entity: { name: string; aliases: ReadonlyArray<{ pattern: string; mode: string }> },
  types: readonly MerchantType[],
  opts: { vocab?: PayeeVocabulary } = {},
): EntityTypeHints {
  const all: EntityTypeHint[] = [];
  const s = suggestMerchantType([entity.name], types, opts);
  if (s) all.push({ group: s.type.group, name: s.type.name, reason: s.reason, source: s.source, strength: "strong", field: "name", matched: entity.name });
  const seen = new Set<string>([payeeMatchKey(entity.name)]);
  for (const a of entity.aliases) {
    if (a.mode !== "exact") continue;
    const k = payeeMatchKey(a.pattern);
    if (seen.has(k)) continue;
    seen.add(k);
    const w = suggestMerchantType([a.pattern], types, opts);
    if (w) all.push({ group: w.type.group, name: w.type.name, reason: `alias “${a.pattern}”: ${w.reason}`, source: w.source, strength: "weak", field: "alias", matched: a.pattern });
  }
  const distinct: EntityTypeHint[] = [];
  for (const h of all) if (!distinct.some((d) => sameMerchantType(d, h))) distinct.push(h);
  const mixed = distinct.length > 1;
  return {
    hint: all[0] ?? null,
    all,
    mixed,
    mixedReason: mixed ? `змішаний: ${distinct.map((d) => `${formatMerchantType(d)} (${d.field === "name" ? "назва" : `alias “${d.matched}”`})`).join(" / ")}` : null,
  };
}
