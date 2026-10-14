/**
 * Payee dictionary export / import (Payee Studio P4) — the base of a future
 * shared package of merchant names.
 *
 * File format (JSON, or the same structure as YAML):
 *   { format: "finlynq-payee-dictionary", version: 2, exportedAt, locale, country,
 *     entries: [{ name, type, aliases: [{ pattern, mode }],
 *                 identifiers: [{ kind, value }], website? }] }
 * P5c: `website` is exported (merchants only) and imported (set when the
 * matching entry has none); logos are never exported.
 * P6: `merchantType: { group, name }` is exported and imported (set when the
 * matching entry has none; a type missing from the user's list is added).
 * P8 stage 7 — v2: `locale` (the language the names are in, e.g. "uk") and
 * `country` (ISO code, "UA") so shared dictionaries can be picked per
 * country; v1 files still import (no locale / country).
 *
 * EXPORT keeps only what is safe to share: entities, their aliases and types,
 * and public identifiers of legal entities (EDRPOU; an IBAN only for
 * company / bank / government). Never: amounts, dates, notes, categories,
 * private persons or sole proprietors (their names are personal data),
 * aliases that look like a person's name or carry long digit runs (card /
 * account numbers), tax ids or card digits.
 *
 * IMPORT is preview first: each entry is matched to the directory by its
 * name and exact aliases (matching key) → `create` (no match), `merge` into
 * one existing entry (adds what is missing), or `conflict` (the name and the
 * aliases point at different entries, or at several) — a conflict needs an
 * explicit decision (`skip`, `create`, or `merge:<entityId>`) before the
 * import can run. Committing runs everything as ONE undoable batch and does
 * not rename stored payees (use Apply afterwards).
 */
import { z } from "zod";
import { guessPayeeType, payeeMatchKey, PAYEE_TYPES, type PayeeType } from "./match-key";
import { ALIAS_MODES, IDENTIFIER_KINDS, normalizeIdentifier, validateAlias, validateEntityName, type AliasMode, type IdentifierKind, type PayeeEntity } from "./directory";
import type { SingleOp } from "./ops";
import { normalizeWebsite } from "./profile";
import { parseMerchantTypeText, validateMerchantTypeRef, type MerchantType, type MerchantTypeRef } from "./merchant-types";
import { st } from "@/lib/i18n/current";

export const DICTIONARY_FORMAT = "finlynq-payee-dictionary";
export const DICTIONARY_VERSION = 2;
export const DICTIONARY_MAX_ENTRIES = 5_000;

export type DictionaryEntry = {
  name: string;
  type: PayeeType;
  aliases: Array<{ pattern: string; mode: AliasMode }>;
  identifiers: Array<{ kind: IdentifierKind; value: string }>;
  /** P5c: the merchant's website (never a logo). */
  website?: string;
  /** P6: the merchant type, group → position. */
  merchantType?: MerchantTypeRef;
};
export type PayeeDictionary = { format: typeof DICTIONARY_FORMAT; version: number; exportedAt: string; locale?: string; country?: string; entries: DictionaryEntry[] };

const PERSON_TYPES = new Set<PayeeType>(["person", "sole_proprietor"]);
const IBAN_SHAREABLE_TYPES = new Set<PayeeType>(["company", "bank", "government"]);

/** Build the shareable dictionary from the directory. */
export function buildDictionary(
  entities: PayeeEntity[],
  now = new Date(),
  merchantTypes: readonly MerchantType[] = [],
  meta: { locale?: string; country?: string } = {},
): PayeeDictionary & { skipped: { people: number; aliases: number; identifiers: number } } {
  const skipped = { people: 0, aliases: 0, identifiers: 0 };
  const entries: DictionaryEntry[] = [];
  for (const e of entities) {
    if (PERSON_TYPES.has(e.type) || guessPayeeType(e.name).isPerson) {
      skipped.people++;
      continue;
    }
    const aliases: DictionaryEntry["aliases"] = [];
    for (const a of e.aliases) {
      if (a.source === "canonical") continue;
      if (guessPayeeType(a.pattern).isPerson || /\d{6,}/.test(a.pattern.replace(/\s+/g, ""))) {
        skipped.aliases++;
        continue;
      }
      aliases.push({ pattern: a.pattern, mode: a.mode });
    }
    const identifiers: DictionaryEntry["identifiers"] = [];
    for (const i of e.identifiers) {
      if (i.kind === "edrpou" || (i.kind === "iban" && IBAN_SHAREABLE_TYPES.has(e.type))) identifiers.push({ kind: i.kind, value: i.value });
      else skipped.identifiers++;
    }
    const mt = e.merchantTypeId == null ? null : merchantTypes.find((t) => t.id === e.merchantTypeId);
    entries.push({ name: e.name, type: e.type, aliases, identifiers, ...(e.website ? { website: e.website } : {}), ...(mt ? { merchantType: { group: mt.group, name: mt.name } } : {}) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { format: DICTIONARY_FORMAT, version: DICTIONARY_VERSION, exportedAt: now.toISOString(), locale: meta.locale ?? "uk", country: meta.country ?? "UA", entries, skipped };
}

// ─── serialization ──────────────────────────────────────────────────────────

export function dictionaryToJson(d: PayeeDictionary): string {
  const { format, version, exportedAt, locale, country, entries } = d;
  return JSON.stringify({ format, version, exportedAt, ...(locale ? { locale } : {}), ...(country ? { country } : {}), entries }, null, 2) + "\n";
}

const q = (s: string) => JSON.stringify(s);

/** Block-style YAML; every string double-quoted (valid YAML 1.2). */
export function dictionaryToYaml(d: PayeeDictionary): string {
  const out = [`format: ${q(d.format)}`, `version: ${d.version}`, `exportedAt: ${q(d.exportedAt)}`, ...(d.locale ? [`locale: ${q(d.locale)}`] : []), ...(d.country ? [`country: ${q(d.country)}`] : []), "entries:"];
  if (!d.entries.length) out[out.length - 1] = "entries: []";
  for (const e of d.entries) {
    out.push(`  - name: ${q(e.name)}`, `    type: ${q(e.type)}`);
    out.push(e.aliases.length ? "    aliases:" : "    aliases: []");
    for (const a of e.aliases) out.push(`      - pattern: ${q(a.pattern)}`, `        mode: ${q(a.mode)}`);
    out.push(e.identifiers.length ? "    identifiers:" : "    identifiers: []");
    for (const i of e.identifiers) out.push(`      - kind: ${q(i.kind)}`, `        value: ${q(i.value)}`);
    if (e.website) out.push(`    website: ${q(e.website)}`);
    if (e.merchantType) out.push("    merchantType:", `      group: ${q(e.merchantType.group)}`, `      name: ${q(e.merchantType.name)}`);
  }
  return out.join("\n") + "\n";
}

/**
 * Parse the YAML subset this dictionary uses: nested mappings and sequences
 * by indentation, `- ` list items, `[]` / `{}` empties, comments, and
 * scalars (double-quoted JSON-style, single-quoted, numbers, plain text).
 */
export function parseSimpleYaml(text: string): unknown {
  type Line = { indent: number; text: string; no: number };
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const noComment = stripComment(raw);
    if (!noComment.trim()) return;
    if (/\t/.test(raw.slice(0, raw.length - raw.trimStart().length))) throw new Error(st("srv.dictionary.yamlTabs", { line: i + 1 }));
    lines.push({ indent: raw.length - raw.trimStart().length, text: noComment.trim(), no: i + 1 });
  });
  let pos = 0;
  const scalar = (v: string, no: number): unknown => {
    if (v === "[]") return [];
    if (v === "{}") return {};
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v);
      } catch {
        throw new Error(st("srv.dictionary.yamlBadQuote", { line: no }));
      }
    }
    if (v.startsWith("'")) {
      if (!v.endsWith("'") || v.length < 2) throw new Error(st("srv.dictionary.yamlBadQuote", { line: no }));
      return v.slice(1, -1).replace(/''/g, "'");
    }
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === "true" || v === "false") return v === "true";
    if (v === "null" || v === "~") return null;
    return v;
  };
  const keyValue = (t: string, no: number): [string, string] => {
    const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(t);
    if (!m) throw new Error(st("srv.dictionary.yamlExpectedKey", { line: no }));
    return [String(scalar(m[1], no)), m[2] ?? ""];
  };
  const block = (indent: number): unknown => {
    if (pos >= lines.length) return null;
    if (lines[pos].text.startsWith("- ") || lines[pos].text === "-") {
      const arr: unknown[] = [];
      while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith("- ") || lines[pos].text === "-")) {
        const l = lines[pos];
        const rest = l.text === "-" ? "" : l.text.slice(2).trim();
        if (!rest) {
          pos++;
          arr.push(pos < lines.length && lines[pos].indent > indent ? block(lines[pos].indent) : null);
        } else if (/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:"']+?)\s*:(\s|$)/.test(rest)) {
          // "- key: value" starts a mapping whose other keys sit at indent + 2.
          lines[pos] = { indent: indent + 2, text: rest, no: l.no };
          arr.push(block(indent + 2));
        } else {
          pos++;
          arr.push(scalar(rest, l.no));
        }
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith("- ")) {
      const l = lines[pos];
      const [k, v] = keyValue(l.text, l.no);
      pos++;
      if (v) obj[k] = scalar(v, l.no);
      else obj[k] = pos < lines.length && lines[pos].indent > indent ? block(lines[pos].indent) : pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("- ") ? block(indent) : null;
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new Error(st("srv.dictionary.yamlIndent", { line: lines[pos].no }));
    return obj;
  };
  const value = block(lines.length ? lines[0].indent : 0);
  if (pos < lines.length) throw new Error(st("srv.dictionary.yamlContent", { line: lines[pos].no }));
  return value;
}

function stripComment(line: string): string {
  let inD = false;
  let inS = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && inD) {
      i++;
      continue;
    }
    if (c === '"' && !inS) inD = !inD;
    else if (c === "'" && !inD) inS = !inS;
    else if (c === "#" && !inD && !inS && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const fileSchema = z.object({
  format: z.literal(DICTIONARY_FORMAT),
  version: z.number().int(),
  exportedAt: z.string().optional(),
  locale: z.string().max(20).optional(),
  country: z.string().max(3).optional(),
  entries: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().optional(),
        aliases: z.array(z.union([z.string(), z.object({ pattern: z.string(), mode: z.string().optional() })])).optional(),
        identifiers: z.array(z.object({ kind: z.string(), value: z.union([z.string(), z.number()]) })).optional(),
        website: z.string().nullable().optional(),
        merchantType: z.union([z.string(), z.object({ group: z.string(), name: z.string().optional() })]).nullable().optional(),
      }),
    )
    .max(DICTIONARY_MAX_ENTRIES),
});

/** Parse + validate a dictionary file (JSON or YAML). Entry problems come back per entry. */
export function parseDictionary(text: string): { entries: DictionaryEntry[]; errors: Array<{ index: number; error: string }>; locale?: string; country?: string } {
  const trimmed = text.trim();
  let raw: unknown;
  try {
    raw = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseSimpleYaml(text);
  } catch (e) {
    throw new Error(st("srv.dictionary.unreadable", { error: e instanceof Error ? e.message : String(e) }));
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const formatOk = raw && typeof raw === "object" && (raw as { format?: unknown }).format === DICTIONARY_FORMAT;
    throw new Error(formatOk ? st("srv.dictionary.invalid", { error: parsed.error.issues[0]?.message ?? st("srv.dictionary.badStructure") }) : st("srv.dictionary.notDictionary", { format: DICTIONARY_FORMAT }));
  }
  if (parsed.data.version > DICTIONARY_VERSION) throw new Error(st("srv.dictionary.version", { version: parsed.data.version, max: DICTIONARY_VERSION }));
  const entries: DictionaryEntry[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  parsed.data.entries.forEach((e, index) => {
    try {
      const name = validateEntityName(e.name);
      const type = (PAYEE_TYPES as readonly string[]).includes(e.type ?? "") ? (e.type as PayeeType) : guessPayeeType(name).type;
      const aliases: DictionaryEntry["aliases"] = [];
      for (const a of e.aliases ?? []) {
        const r = typeof a === "string" ? { pattern: a, mode: "exact" } : a;
        const mode: AliasMode = (ALIAS_MODES as readonly string[]).includes(r.mode ?? "exact") ? ((r.mode ?? "exact") as AliasMode) : "exact";
        aliases.push({ pattern: validateAlias(r.pattern, mode), mode });
      }
      const identifiers: DictionaryEntry["identifiers"] = [];
      for (const i of e.identifiers ?? []) {
        if (!(IDENTIFIER_KINDS as readonly string[]).includes(i.kind)) throw new Error(st("srv.dictionary.unknownKind", { kind: i.kind }));
        identifiers.push({ kind: i.kind as IdentifierKind, value: normalizeIdentifier(i.kind as IdentifierKind, String(i.value)) });
      }
      const website = e.website?.trim() && type !== "person" && type !== "sole_proprietor" ? normalizeWebsite(e.website) : undefined;
      let merchantType: MerchantTypeRef | undefined;
      if (e.merchantType) {
        const r = typeof e.merchantType === "string" ? parseMerchantTypeText(e.merchantType) : e.merchantType;
        merchantType = validateMerchantTypeRef({ group: r.group ?? r.name, name: r.name });
      }
      entries.push({ name, type, aliases, identifiers, ...(website ? { website } : {}), ...(merchantType ? { merchantType } : {}) });
    } catch (err) {
      errors.push({ index, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return { entries, errors, ...(parsed.data.locale ? { locale: parsed.data.locale } : {}), ...(parsed.data.country ? { country: parsed.data.country } : {}) };
}

// ─── import plan ────────────────────────────────────────────────────────────

export type Resolution = "skip" | "create" | `merge:${number}`;

export type ImportPlanItem = {
  index: number;
  name: string;
  type: PayeeType;
  action: "create" | "merge" | "skip" | "conflict" | "unchanged";
  target: { id: number; name: string } | null;
  /** Entries the name / aliases point at, for a conflict. */
  candidates: Array<{ id: number; name: string }>;
  newAliases: Array<{ pattern: string; mode: AliasMode }>;
  newIdentifiers: Array<{ kind: IdentifierKind; value: string }>;
  /** P5c: a website the entry brings (set only when the directory entry has none). */
  newWebsite: string | null;
  /** P6: a merchant type the entry brings (set only when the directory entry has none). */
  newMerchantType: MerchantTypeRef | null;
  note: string | null;
};

/** Decide what each entry does against the current directory. Pure. */
export function planDictionaryImport(entries: DictionaryEntry[], directory: PayeeEntity[], resolutions: Record<number, Resolution> = {}): ImportPlanItem[] {
  const owners = (pattern: string) => {
    const k = payeeMatchKey(pattern);
    return directory.filter((e) => e.aliases.some((a) => a.mode === "exact" && payeeMatchKey(a.pattern) === k));
  };
  const plannedKeys = new Map<string, number>();
  return entries.map((entry, index) => {
    const hits = new Map<number, PayeeEntity>();
    for (const p of [entry.name, ...entry.aliases.filter((a) => a.mode === "exact").map((a) => a.pattern)]) for (const o of owners(p)) hits.set(o.id, o);
    const candidates = [...hits.values()].map((e) => ({ id: e.id, name: e.name }));
    const base: ImportPlanItem = { index, name: entry.name, type: entry.type, action: "create", target: null, candidates, newAliases: [], newIdentifiers: [], newWebsite: null, newMerchantType: null, note: null };
    const res = resolutions[index];
    let target: PayeeEntity | null = null;
    if (res === "skip") return { ...base, action: "skip" };
    if (res && res.startsWith("merge:")) {
      target = directory.find((e) => e.id === Number(res.slice(6))) ?? null;
      if (!target) return { ...base, action: "conflict", note: st("srv.dictionary.targetGone") };
    } else if (res === "create") {
      if (hits.size) return { ...base, action: "conflict", note: st("srv.dictionary.nameOwned", { name: candidates[0].name }) };
    } else if (hits.size === 1) {
      target = [...hits.values()][0];
    } else if (hits.size > 1) {
      return { ...base, action: "conflict", note: st("srv.dictionary.manyOwners", { n: hits.size }) };
    }
    // A second file entry with the same name as an earlier one in this file.
    const nameKey = payeeMatchKey(entry.name);
    if (!target && plannedKeys.has(nameKey)) return { ...base, action: "conflict", note: st("srv.dictionary.duplicate", { n: plannedKeys.get(nameKey)! + 1 }) };
    if (!target) plannedKeys.set(nameKey, index);
    const known = target ? target.aliases : [];
    const newAliases = entry.aliases.filter((a) => {
      if (a.mode === "exact") {
        const k = payeeMatchKey(a.pattern);
        if (k === payeeMatchKey(target ? target.name : entry.name)) return false;
        if (known.some((x) => x.mode === "exact" && payeeMatchKey(x.pattern) === k)) return false;
        return owners(a.pattern).every((o) => o.id === target?.id);
      }
      return !known.some((x) => x.mode === a.mode && x.pattern === a.pattern);
    });
    // Matched through an alias only: the file's name becomes an alias too.
    if (target && !owners(entry.name).some((o) => o.id === target!.id)) newAliases.unshift({ pattern: entry.name, mode: "exact" });
    const newIdentifiers = entry.identifiers.filter((i) => !(target?.identifiers ?? []).some((x) => x.kind === i.kind && x.value === i.value));
    if (target) {
      const newWebsite = entry.website && !target.website ? entry.website : null;
      const newMerchantType = entry.merchantType && target.merchantTypeId == null ? entry.merchantType : null;
      const nothing = newAliases.length === 0 && newIdentifiers.length === 0 && !newWebsite && !newMerchantType;
      return {
        ...base,
        action: nothing ? "unchanged" : "merge",
        target: { id: target.id, name: target.name },
        newAliases,
        newIdentifiers,
        newWebsite,
        newMerchantType,
        note: target.type !== entry.type ? st("srv.dictionary.typeDiffers", { type: target.type }) : null,
      };
    }
    return { ...base, action: "create", newAliases, newIdentifiers, newWebsite: entry.website ?? null, newMerchantType: entry.merchantType ?? null };
  });
}

/** The ops a plan runs (create / alias_add / identifiers), never renaming stored payees. */
export function dictionaryImportOps(plan: ImportPlanItem[]): { ops: SingleOp[]; labels: string[] } {
  const ops: SingleOp[] = [];
  const labels: string[] = [];
  for (const p of plan) {
    const label = `entry #${p.index + 1} ("${p.name}")`;
    if (p.action === "create") {
      ops.push({ op: "create", name: p.name, type: p.type, aliases: p.newAliases, identifiers: p.newIdentifiers, website: p.newWebsite, ...(p.newMerchantType ? { merchantType: p.newMerchantType } : {}), apply: false });
      labels.push(label);
    } else if (p.action === "merge" && p.target) {
      if (p.newAliases.length) {
        ops.push({ op: "alias_add", entityId: p.target.id, aliases: p.newAliases, apply: false });
        labels.push(label);
      }
      if (p.newIdentifiers.length) {
        ops.push({ op: "identifiers", entityId: p.target.id, add: p.newIdentifiers });
        labels.push(label);
      }
      if (p.newWebsite || p.newMerchantType) {
        ops.push({ op: "update", entityId: p.target.id, ...(p.newWebsite ? { website: p.newWebsite } : {}), ...(p.newMerchantType ? { merchantType: p.newMerchantType } : {}), apply: false });
        labels.push(label);
      }
    }
  }
  return { ops, labels };
}
