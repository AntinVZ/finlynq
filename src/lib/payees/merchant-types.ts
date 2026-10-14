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
import { st } from "@/lib/i18n/current";

const iso = (s: string) => normalizeForMatch(s).replace(/\s+/g, " ").trim();

export type MerchantType = {
  /** null = a built-in default not written yet (the user has no rows). */
  id: number | null;
  group: string;
  name: string;
  sort: number;
  defaultCategoryId: number | null;
  /**
   * P8 stage 6: the stable key of a built-in position (`cafe`, `fuel`, …),
   * kept when the user renames it; null for the user's own types. Hints and
   * MCC suggestions find a type by this key first, and the interface shows a
   * built-in type under its translated name while its name is unchanged.
   */
  code: string | null;
};

export type MerchantTypeRef = { group: string; name: string; code?: string | null };

/** Starting set: group → positions (a group without positions is its own single position, same code). */
export const DEFAULT_MERCHANT_TYPES: ReadonlyArray<{ group: string; code: string; names?: ReadonlyArray<{ name: string; code: string }> }> = [
  { group: "Кафе, ресторани, бари", code: "food", names: [{ name: "Кафе", code: "cafe" }, { name: "Ресторани", code: "restaurant" }, { name: "Бари", code: "bar" }] },
  { group: "Готелі", code: "hotel" },
  { group: "Пальне (АЗС)", code: "fuel" },
  { group: "Супермаркети і продукти", code: "grocery" },
  { group: "Аптеки", code: "pharmacy" },
  { group: "Транспорт і таксі", code: "transport" },
  { group: "Онлайн-сервіси та підписки", code: "online_services" },
  { group: "Маркетплейси", code: "marketplace" },
  { group: "Одяг і взуття", code: "clothing" },
  { group: "Побутова техніка", code: "electronics" },
  { group: "Ремонт і будівництво", code: "home_improvement" },
  { group: "Комунальні й зв'язок", code: "utilities" },
  { group: "Банки і комісії", code: "bank_fees" },
  { group: "Банківські операції", code: "bank_operations" },
  { group: "Держава і податки", code: "government" },
  { group: "Освіта і медицина", code: "education_health" },
  { group: "Розваги", code: "entertainment" },
  { group: "Особи і ФОП", code: "persons" },
  { group: "Колеги", code: "colleagues" },
  { group: "Інше", code: "other" },
];

/** A built-in position by its stable key: its starting-set group, name, and the group's key. */
export function defaultMerchantTypeByCode(code: string | null | undefined): (MerchantTypeRef & { code: string; groupCode: string }) | null {
  if (!code) return null;
  for (const g of DEFAULT_MERCHANT_TYPES) {
    for (const p of g.names ?? [{ name: g.group, code: g.code }]) if (p.code === code) return { group: g.group, name: p.name, code: p.code, groupCode: g.code };
  }
  return null;
}

/** The stable key of a starting-set position given by its (Ukrainian) group and name, or null. */
export function defaultMerchantTypeCode(ref: MerchantTypeRef): string | null {
  for (const g of DEFAULT_MERCHANT_TYPES) {
    for (const p of g.names ?? [{ name: g.group, code: g.code }]) if (sameMerchantType({ group: g.group, name: p.name }, ref)) return p.code;
  }
  return null;
}

/** A built-in position as a reference, by key (throws on an unknown key: a programming error). */
function builtin(code: string): MerchantTypeRef & { code: string } {
  const d = defaultMerchantTypeByCode(code);
  if (!d) throw new Error(`Unknown merchant type code ${code}`);
  return { group: d.group, name: d.name, code: d.code };
}

/** The bank's own service rows (B25) land here. */
export const BANK_OPERATIONS_TYPE: MerchantTypeRef & { code: string } = builtin("bank_operations");

/**
 * How the interface shows a type (P8 stage 6): a built-in group or position
 * whose name the user has not changed appears under its translated name
 * (`mtype.<code>` / `mtypeGroup.<groupCode>`); anything the user named or
 * renamed appears as written.
 */
export function localizeMerchantType(
  t: MerchantTypeRef,
  tr: (key: string) => string,
): { group: string; name: string } {
  const def = defaultMerchantTypeByCode(t.code ?? defaultMerchantTypeCode(t));
  if (!def) return { group: t.group, name: t.name };
  const name = iso(t.name) === iso(def.name) ? tr(`mtype.${def.code}`) : t.name;
  const group = iso(t.group) === iso(def.group) ? tr(`mtypeGroup.${def.groupCode}`) : t.group;
  return { group, name };
}

export const MERCHANT_TYPE_NAME_MAX = 80;

/** The built-in starting set as rows (no ids), in display order. */
export function defaultMerchantTypes(): MerchantType[] {
  const out: MerchantType[] = [];
  for (const g of DEFAULT_MERCHANT_TYPES) {
    for (const p of g.names ?? [{ name: g.group, code: g.code }]) out.push({ id: null, group: g.group, name: p.name, sort: out.length * 10, defaultCategoryId: null, code: p.code });
  }
  return out;
}


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
  if (!group) throw new Error(st("srv.mtype.groupRequired"));
  if (group.length > MERCHANT_TYPE_NAME_MAX || name.length > MERCHANT_TYPE_NAME_MAX) throw new Error(st("srv.mtype.nameTooLong", { max: MERCHANT_TYPE_NAME_MAX }));
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
  if (typeof ref === "object") return (ref.code ? types.find((t) => t.code === ref.code) : undefined) ?? types.find((t) => sameMerchantType(t, ref)) ?? null;
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
  code: r.code == null ? null : String(r.code),
});

/** The user's types (sorted), or the virtual starting set when they have none. Read only. */
export async function loadMerchantTypes(executor: PayeeExecutor, userId: string): Promise<MerchantType[]> {
  const rows = normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`
      SELECT id, group_name, name, sort, default_category_id, code FROM payee_merchant_types
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
      INSERT INTO payee_merchant_types (user_id, group_name, name, sort, code)
      VALUES (${userId}, ${t.group}, ${t.name}, ${t.sort}, ${t.code})
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
export const MCC_TYPES: Record<string, MerchantTypeRef & { code: string }> = Object.fromEntries(
  (
    [
      ["5812", "restaurant"], ["5813", "bar"], ["5814", "cafe"], ["5462", "cafe"],
      ["7011", "hotel"], ["5541", "fuel"], ["5542", "fuel"],
      ["5411", "grocery"], ["5499", "grocery"], ["5912", "pharmacy"],
      ["4121", "transport"], ["4111", "transport"], ["4131", "transport"],
      ["5651", "clothing"], ["5661", "clothing"], ["5691", "clothing"],
      ["5722", "electronics"], ["5732", "electronics"], ["5200", "home_improvement"], ["5211", "home_improvement"],
      ["4814", "utilities"], ["4900", "utilities"], ["6011", "bank_operations"], ["6012", "bank_fees"],
      ["9311", "government"], ["8011", "education_health"], ["8062", "education_health"], ["8220", "education_health"],
      ["7832", "entertainment"], ["7922", "entertainment"],
    ] as const
  ).map(([mcc, code]) => [mcc, builtin(code)]),
);

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
      if (t) return { type: t, reason: st("srv.mtype.reasonTypeWord", { word: bc.removed[0] }), source: "type_word" };
    }
  }
  for (const n of names) {
    const op = bankOperationOf(n, opts.vocab);
    if (op) {
      const t = pick(BANK_OPERATIONS_TYPE);
      if (t) return { type: t, reason: st("srv.mtype.reasonBankOperation", { pattern: op }), source: "bank_operation" };
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
    if (w) all.push({ group: w.type.group, name: w.type.name, reason: st("srv.mtype.reasonAlias", { alias: a.pattern, reason: w.reason }), source: w.source, strength: "weak", field: "alias", matched: a.pattern });
  }
  const distinct: EntityTypeHint[] = [];
  for (const h of all) if (!distinct.some((d) => sameMerchantType(d, h))) distinct.push(h);
  const mixed = distinct.length > 1;
  return {
    hint: all[0] ?? null,
    all,
    mixed,
    mixedReason: mixed ? st("srv.mtype.mixed", { types: distinct.map((d) => `${formatMerchantType(d)} (${d.field === "name" ? st("srv.mtype.fieldName") : st("srv.mtype.fieldAlias", { alias: d.matched })})`).join(" / ") }) : null,
  };
}
