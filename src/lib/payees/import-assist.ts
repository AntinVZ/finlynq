/**
 * Payee Studio on import (P3): the import hint and the autopilot. Both are
 * OFF by default (Merchants settings).
 *
 *   - IMPORT HINT: a newly staged row whose payee matches a directory alias
 *     (any mode, one entity only) gets the entity's canonical name. Also used
 *     for a single manual transaction (`canonicalPayeeHint`).
 *   - AUTOPILOT: a newly staged row whose payee is NEW (no alias matches) but
 *     whose matching key is close to exactly ONE entity's exact alias, at or
 *     above the threshold, is renamed and its spelling added to that entity
 *     as an alias (source `autopilot`). Never for people / sole proprietors
 *     (either side), never when two entities are close.
 *
 * Staged rows are re-encrypted at their own tier; `import_hash` is never
 * recomputed. Each kind of change is ONE payee batch (actor `import` /
 * `autopilot`), so Merchants → Changes can undo it for 30 days.
 * Failures never break an import: callers wrap this in try/catch.
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { encryptField } from "@/lib/crypto/envelope";
import { encryptStaged } from "@/lib/crypto/staging-envelope";
import { guessPayeeType, payeeMatchKey } from "./match-key";
import { buildPayeeMatcher, findByIdentifier, insertAlias, loadDirectory, type PayeeEntity } from "./directory";
import { extractRequisites } from "./requisites";
import { loadOwnMatcher, type OwnMatcher } from "./own-accounts";
import { loadMerchantTypes, suggestMerchantType } from "./merchant-types";
import { runPayeeBatch, writeStoredPayees } from "./batches";
import { scoreKeys } from "./overview";
import { bankOperationOf, channelOf, type PayeeVocabulary } from "./type-words";
import { getPayeeSettings, vocabularyOf } from "./settings";
import { invalidatePayeeSuggest } from "./suggest";
import { decodeStoredPayee, spellingOf, type PayeeExecutor } from "./scan";


const encodeStaged = (tier: string | null, dek: Buffer, name: string) => (tier === "user" ? encryptField(dek, name) : encryptStaged(name));

/**
 * The best directory entry for a NEW payee by key similarity, or null when
 * none clears `threshold` or two entries do (ambiguous).
 */
export function autopilotMatch(
  payee: string,
  entities: PayeeEntity[],
  threshold: number,
  vocab?: PayeeVocabulary,
): { entity: PayeeEntity; confidence: number; reason: string } | null {
  const key = payeeMatchKey(payee);
  if (!key || guessPayeeType(payee).isPerson || bankOperationOf(payee, vocab) || channelOf(payee)) return null;
  const hits: Array<{ entity: PayeeEntity; confidence: number; reason: string }> = [];
  for (const e of entities) {
    if (e.type === "person" || e.type === "sole_proprietor") continue;
    let best: { confidence: number; reason: string } | null = null;
    for (const a of e.aliases) {
      if (a.mode !== "exact") continue;
      const s = scoreKeys(key, payeeMatchKey(a.pattern), vocab);
      // P6: different brand tokens are never joined automatically.
      if (s && s.sameBrand && (!best || s.confidence > best.confidence)) best = { confidence: s.confidence, reason: s.reason };
    }
    if (best && best.confidence >= threshold) hits.push({ entity: e, ...best });
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * What happened to an import's payees (P8 stage 10), in the input order:
 * requisite → exact alias → other alias (contains / regex) → merchant type
 * (type word / MCC, no entry) → the queue. Channels (`OTPC2C`, `P24`…),
 * own-account transfers and bank operations are counted apart and never
 * proposed. `hinted` / `autopilot` are the rows actually renamed (0 in a
 * read-only summary).
 */
export type ImportPayeeSummary = {
  rows: number;
  byRequisite: number;
  byAlias: number;
  byPattern: number;
  byType: number;
  channels: number;
  own: number;
  bankOps: number;
  ambiguous: number;
  /** Rows left for Merchants → Queue, and how many distinct spellings they are. */
  toQueue: number;
  newSpellings: number;
  hinted: number;
  autopilot: number;
  aliasesAdded: number;
};

export type ImportAssistResult = { hinted: number; autopilot: number; aliasesAdded: number; batchIds: number[]; summary: ImportPayeeSummary };

const emptySummary = (): ImportPayeeSummary => ({ rows: 0, byRequisite: 0, byAlias: 0, byPattern: 0, byType: 0, channels: 0, own: 0, bankOps: 0, ambiguous: 0, toQueue: 0, newSpellings: 0, hinted: 0, autopilot: 0, aliasesAdded: 0 });

/** The one entry a row's requisites (IBAN / ЄДРПОУ / ІПН — never a card's last 4) point to, or null. */
function entityByRequisite(text: string, entities: PayeeEntity[], own: OwnMatcher): PayeeEntity | "own" | null {
  let hit: PayeeEntity | null = null;
  for (const r of extractRequisites(text)) {
    if (own.byValue(r.kind, r.value)) return "own";
    if (r.kind === "card_last4") continue;
    const found = findByIdentifier(entities, r.value);
    if (found.length !== 1) continue;
    if (hit && hit.id !== found[0].id) return null;
    hit = found[0];
  }
  return hit;
}

/**
 * Run the import hint and the autopilot over one staged import, and say
 * what happened to its payees. `readOnly` = the summary only (nothing is
 * renamed, no alias is added): the staged review page uses it for imports
 * staged without the key (email).
 */
export async function applyPayeeImportAssist(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer;
  stagedImportId: string;
  readOnly?: boolean;
}): Promise<ImportAssistResult> {
  const { executor, userId, dek, stagedImportId } = opts;
  const summary = emptySummary();
  const out: ImportAssistResult = { hinted: 0, autopilot: 0, aliasesAdded: 0, batchIds: [], summary };
  const settings = await getPayeeSettings(executor, userId);
  const vocab = vocabularyOf(settings);
  const doHint = settings.importHint && !opts.readOnly;
  const doAuto = settings.autopilotEnabled && !opts.readOnly;
  const directory = await loadDirectory(executor, userId, dek);
  const matcher = buildPayeeMatcher(directory);
  const own = await loadOwnMatcher(executor, userId, dek);
  const types = await loadMerchantTypes(executor, userId);

  const rows = normalizeDbRows<{ id: unknown; payee: unknown; note: unknown; tier: unknown }>(
    await executor.execute(sql`
      SELECT id, payee, note, encryption_tier AS tier FROM staged_transactions
      WHERE user_id = ${userId} AND staged_import_id = ${stagedImportId}
      ORDER BY row_index`),
  );
  const hint: Array<{ id: string; stored: string | null; tier: string | null; name: string }> = [];
  const auto = new Map<string, { spelling: string; entity: PayeeEntity; rows: Array<{ id: string; stored: string | null; tier: string | null }> }>();
  const queued = new Set<string>();
  for (const r of rows) {
    const tier = r.tier == null ? null : String(r.tier);
    const plain = decodeStoredPayee(r.payee, tier, dek);
    if (plain === undefined) continue;
    const spelling = spellingOf(plain);
    if (!spelling) continue;
    summary.rows++;
    const stored = r.payee == null ? null : String(r.payee);
    const note = decodeStoredPayee(r.note, tier, dek) ?? "";
    // 1. A requisite (IBAN / code) of exactly one entry — or of an own account.
    const byReq = directory.length || own.accounts.length ? entityByRequisite(`${spelling} ${note}`, directory, own) : null;
    if (byReq === "own" || own.inText(spelling)) {
      summary.own++;
      continue;
    }
    if (byReq) {
      summary.byRequisite++;
      if (doHint && plain !== byReq.name) hint.push({ id: String(r.id), stored, tier, name: byReq.name });
      continue;
    }
    // 2. An alias: exact first, then contains / regex.
    const m = matcher.match(spelling);
    if (m.kind === "match") {
      if (m.via === "exact") summary.byAlias++;
      else summary.byPattern++;
      if (doHint && plain !== m.name) hint.push({ id: String(r.id), stored, tier, name: m.name });
      continue;
    }
    if (m.kind === "ambiguous") {
      summary.ambiguous++;
      continue;
    }
    // Channels and the bank's own service rows are never merchants.
    if (channelOf(spelling)) {
      summary.channels++;
      continue;
    }
    if (bankOperationOf(spelling, vocab)) {
      summary.bankOps++;
      continue;
    }
    // Autopilot (new spelling close to exactly one entry).
    const key = payeeMatchKey(spelling);
    if (doAuto && key) {
      const known = auto.get(key);
      if (known) {
        known.rows.push({ id: String(r.id), stored, tier });
        continue;
      }
      const hit = autopilotMatch(spelling, directory, settings.autopilotThreshold, vocab);
      if (hit) {
        auto.set(key, { spelling, entity: hit.entity, rows: [{ id: String(r.id), stored, tier }] });
        continue;
      }
    }
    // 3. A merchant type from the text (type word / MCC) — no entry yet, still queued.
    if (suggestMerchantType([spelling, note], types, { vocab })) summary.byType++;
    // 4. The queue.
    summary.toQueue++;
    if (key) queued.add(key);
  }
  summary.newSpellings = queued.size;

  if (hint.length) {
    const { batchId } = await runPayeeBatch({ executor, userId, dek, kind: "import_hint", actor: "import" }, async (tx, journal) => {
      const writes = hint.map((h) => ({ id: h.id, value: encodeStaged(h.tier, dek, h.name) }));
      await writeStoredPayees(tx, userId, "staged", writes);
      hint.forEach((h, i) => journal.rowChanged({ t: "staged", id: h.id, old: h.stored, new: writes[i].value }));
      journal.count("staged", writes.length);
    });
    out.hinted = hint.length;
    if (batchId != null) out.batchIds.push(batchId);
  }

  if (auto.size) {
    const { batchId } = await runPayeeBatch({ executor, userId, dek, kind: "autopilot", actor: "autopilot" }, async (tx, journal) => {
      for (const slot of auto.values()) {
        await journal.willModify([slot.entity.id]);
        await insertAlias(tx, userId, dek, { entityId: slot.entity.id, pattern: slot.spelling, mode: "exact", source: "autopilot" });
        journal.count("aliases_added");
        out.aliasesAdded++;
        const writes = slot.rows.map((r) => ({ id: r.id, value: encodeStaged(r.tier, dek, slot.entity.name) }));
        await writeStoredPayees(tx, userId, "staged", writes);
        slot.rows.forEach((r, i) => journal.rowChanged({ t: "staged", id: r.id, old: r.stored, new: writes[i].value }));
        journal.count("staged", writes.length);
        out.autopilot += writes.length;
      }
    });
    if (batchId != null) out.batchIds.push(batchId);
  }
  summary.hinted = out.hinted;
  summary.autopilot = out.autopilot;
  summary.aliasesAdded = out.aliasesAdded;
  if (out.batchIds.length) invalidatePayeeSuggest(userId);
  return out;
}

/**
 * The canonical name for one payee about to be saved (a manual transaction),
 * or null when the import hint is off or no single alias matches.
 */
export async function canonicalPayeeHint(executor: PayeeExecutor, userId: string, dek: Buffer, payee: string): Promise<string | null> {
  if (!payee.trim()) return null;
  const settings = await getPayeeSettings(executor, userId);
  if (!settings.importHint) return null;
  const directory = await loadDirectory(executor, userId, dek);
  if (!directory.length) return null;
  const m = buildPayeeMatcher(directory).match(spellingOf(payee));
  return m.kind === "match" && m.name !== payee ? m.name : null;
}

/**
 * A reusable import hint for paths that turn many rows into transactions at
 * once (P5e / B13, B14, B19): staged or bank rows materialized into
 * `transactions` (reconcile materialize, rule auto-apply, bank-row approve /
 * categorize, email "Record"), direct file / connector imports
 * (`executeImport`) and MCP writes. Loads the settings and the directory ONCE
 * and returns `payee → canonical name` (identity when the import hint is
 * off, the directory is empty, or no single alias matches). Only the new
 * transaction's payee changes: bank-ledger rows keep their text and
 * `import_hash` is never recomputed. Never throws — a failure means "no hint".
 */
export async function makePayeeHinter(executor: PayeeExecutor, userId: string, dek: Buffer | null | undefined): Promise<(payee: string) => string> {
  const identity = (p: string) => p;
  if (!dek) return identity;
  try {
    const settings = await getPayeeSettings(executor, userId);
    if (!settings.importHint) return identity;
    const directory = await loadDirectory(executor, userId, dek);
    if (!directory.length) return identity;
    const matcher = buildPayeeMatcher(directory);
    return (payee: string) => {
      if (!payee || !payee.trim()) return payee;
      const m = matcher.match(spellingOf(payee));
      return m.kind === "match" ? m.name : payee;
    };
  } catch (err) {
    console.warn("[payees] import hint unavailable:", err instanceof Error ? err.message : String(err));
    return identity;
  }
}
