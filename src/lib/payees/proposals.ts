/**
 * AI proposals (Payee Studio P3). The server never calls a model: an AI
 * client asks for a compact REVIEW PACK, thinks, and submits PROPOSALS
 * ({ canonical, type, aliases, identifiers, reason, confidence }). They are
 * stored as drafts in `payee_proposals` (payload encrypted) and change
 * nothing until a person approves them; approving runs all selected drafts
 * as ONE payee batch (./ops.ts bulk), undoable for 30 days — undoing it puts
 * the drafts back to `draft`.
 *
 * Safety:
 *   - a proposal touching a private person / sole proprietor is flagged
 *     `needsDecision` and is never part of "accept all above threshold";
 *   - identifiers are normalized on submit (a card number is cut to its last
 *     4 digits before it is stored) and masked when listed for MCP;
 *   - a proposal whose exact alias already belongs to another entity is
 *     stored with a conflict note; approving it fails until fixed (pass
 *     `entityId` to attach to that entity instead).
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { guessPayeeType, payeeMatchKey, PAYEE_TYPES, type PayeeType } from "./match-key";
import {
  ALIAS_MODES,
  exactAliasOwners,
  IDENTIFIER_KINDS,
  loadDirectory,
  maskIdentifier,
  normalizeIdentifier,
  PayeeDirectoryError,
  validateAlias,
  validateEntityName,
  type AliasMode,
  type IdentifierKind,
} from "./directory";
import { executePayeeOp, type PayeeOpResult, type SingleOp } from "./ops";
import { normalizeWebsite } from "./profile";
import type { BatchActor } from "./batches";
import type { PayeeOverview } from "./service";
import type { PayeeExecutor } from "./scan";

export const MAX_PROPOSALS_PER_CALL = 100;

export type ProposalInput = {
  canonical: string;
  type?: string;
  /** Attach to this existing entity instead of creating one. */
  entityId?: number;
  aliases?: Array<string | { pattern: string; mode?: string }>;
  identifiers?: Array<{ kind: string; value: string }>;
  /** P5c: the merchant's website (found by the AI client, e.g. by web search). */
  website?: string;
  reason?: string;
  confidence?: number;
};

export type ProposalPayload = {
  canonical: string;
  type: PayeeType;
  entityId: number | null;
  aliases: Array<{ pattern: string; mode: AliasMode }>;
  identifiers: Array<{ kind: IdentifierKind; value: string }>;
  /** P5c: normalized https URL. Never kept for a private person / sole proprietor. */
  website?: string | null;
  reason: string;
  /** Plain-language problems found when it was submitted (e.g. an alias owned elsewhere). */
  notes: string[];
};

export type Proposal = ProposalPayload & {
  id: number;
  status: "draft" | "approved" | "rejected";
  confidence: number;
  needsDecision: boolean;
  source: string;
  batchId: number | null;
  createdAt: string;
  decidedAt: string | null;
};

const ts = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** Validate and normalize one AI proposal. Throws PayeeDirectoryError with a plain message. */
export function normalizeProposal(input: ProposalInput): { payload: ProposalPayload; confidence: number; needsDecision: boolean } {
  const canonical = validateEntityName(input.canonical ?? "");
  const type: PayeeType = input.type && (PAYEE_TYPES as readonly string[]).includes(input.type) ? (input.type as PayeeType) : guessPayeeType(canonical).type;
  const aliases: ProposalPayload["aliases"] = [];
  for (const a of input.aliases ?? []) {
    const raw = typeof a === "string" ? { pattern: a } : a;
    const mode: AliasMode = raw.mode && (ALIAS_MODES as readonly string[]).includes(raw.mode) ? (raw.mode as AliasMode) : "exact";
    const pattern = validateAlias(raw.pattern ?? "", mode);
    if (mode === "exact" && payeeMatchKey(pattern) === payeeMatchKey(canonical)) continue; // the canonical name covers it
    if (aliases.some((x) => x.mode === mode && (mode === "exact" ? payeeMatchKey(x.pattern) === payeeMatchKey(pattern) : x.pattern === pattern))) continue;
    aliases.push({ pattern, mode });
  }
  const identifiers: ProposalPayload["identifiers"] = [];
  for (const i of input.identifiers ?? []) {
    if (!(IDENTIFIER_KINDS as readonly string[]).includes(i.kind)) throw new PayeeDirectoryError(`Unknown identifier kind "${i.kind}".`);
    identifiers.push({ kind: i.kind as IdentifierKind, value: normalizeIdentifier(i.kind as IdentifierKind, String(i.value ?? "")) });
  }
  const confidence = Math.round(Math.min(1, Math.max(0, Number(input.confidence ?? 0) || 0)) * 100) / 100;
  const names = [canonical, ...aliases.filter((a) => a.mode === "exact").map((a) => a.pattern)];
  const people = names.filter((n) => guessPayeeType(n).isPerson);
  const needsDecision = type === "person" || type === "sole_proprietor" || people.length > 0;
  const reason = String(input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
  const notes: string[] = [];
  let website: string | null = null;
  if (input.website?.trim()) {
    if (type === "person" || type === "sole_proprietor") notes.push("Website skipped: private persons and sole proprietors don't get one.");
    else website = normalizeWebsite(input.website);
  }
  return {
    payload: { canonical, type, entityId: input.entityId ?? null, aliases, identifiers, website, reason, notes },
    confidence,
    needsDecision,
  };
}

/** Store proposals as drafts. Nothing in the directory or the ledger changes. */
export async function saveProposals(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer;
  proposals: ProposalInput[];
  source?: string;
}): Promise<{ saved: Array<{ id: number; canonical: string; needsDecision: boolean; notes: string[] }>; rejected: Array<{ index: number; error: string }> }> {
  const { executor, userId, dek } = opts;
  if (opts.proposals.length > MAX_PROPOSALS_PER_CALL) throw new PayeeDirectoryError(`At most ${MAX_PROPOSALS_PER_CALL} proposals per call.`);
  const directory = await loadDirectory(executor, userId, dek);
  const saved: Array<{ id: number; canonical: string; needsDecision: boolean; notes: string[] }> = [];
  const rejected: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < opts.proposals.length; i++) {
    let norm: ReturnType<typeof normalizeProposal>;
    try {
      norm = normalizeProposal(opts.proposals[i]);
    } catch (e) {
      rejected.push({ index: i, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const p = norm.payload;
    if (p.entityId != null && !directory.some((e) => e.id === p.entityId)) {
      rejected.push({ index: i, error: `No payee entity #${p.entityId}.` });
      continue;
    }
    for (const name of [p.entityId == null ? p.canonical : null, ...p.aliases.filter((a) => a.mode === "exact").map((a) => a.pattern)]) {
      if (!name) continue;
      const owner = exactAliasOwners(directory, name, p.entityId ?? undefined)[0];
      if (owner) p.notes.push(`"${name}" already belongs to "${owner.name}" (#${owner.id}); propose with entity_id ${owner.id} to extend it instead.`);
    }
    const rows = normalizeDbRows<{ id: unknown }>(
      await executor.execute(sql`
        INSERT INTO payee_proposals (user_id, status, confidence, needs_decision, payload, source)
        VALUES (${userId}, 'draft', ${norm.confidence}, ${norm.needsDecision}, ${encryptField(dek, JSON.stringify(p))}, ${opts.source ?? "mcp"})
        RETURNING id`),
    );
    saved.push({ id: Number(rows[0].id), canonical: p.canonical, needsDecision: norm.needsDecision, notes: p.notes });
  }
  return { saved, rejected };
}

export async function listProposals(
  executor: PayeeExecutor,
  userId: string,
  dek: Buffer | null,
  opts: { status?: Proposal["status"] | "all"; ids?: number[]; limit?: number } = {},
): Promise<Proposal[]> {
  const status = opts.status ?? "draft";
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const rows = normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`
      SELECT id, status, confidence, needs_decision, payload, source, batch_id, created_at, decided_at
      FROM payee_proposals
      WHERE user_id = ${userId}
        ${status !== "all" ? sql`AND status = ${status}` : sql``}
        ${opts.ids?.length ? sql`AND id IN (${sql.join(opts.ids.map((i) => sql`${i}`), sql`, `)})` : sql``}
      ORDER BY confidence DESC, id DESC
      LIMIT ${limit}`),
  );
  const out: Proposal[] = [];
  for (const r of rows) {
    const plain = dek ? tryDecryptField(dek, String(r.payload), "payee-proposal") : null;
    if (!plain) continue;
    const p = JSON.parse(plain) as ProposalPayload;
    out.push({
      ...p,
      notes: p.notes ?? [],
      id: Number(r.id),
      status: String(r.status) as Proposal["status"],
      confidence: Number(r.confidence),
      needsDecision: r.needs_decision === true || r.needs_decision === "t",
      source: String(r.source),
      batchId: r.batch_id == null ? null : Number(r.batch_id),
      createdAt: ts(r.created_at) ?? "",
      decidedAt: ts(r.decided_at),
    });
  }
  return out;
}

/** A proposal as ops (create, or extend an existing entity). */
function proposalOps(p: Proposal): SingleOp[] {
  if (p.entityId != null) {
    const ops: SingleOp[] = [];
    if (p.aliases.length) ops.push({ op: "alias_add", entityId: p.entityId, aliases: p.aliases });
    if (p.identifiers.length) ops.push({ op: "identifiers", entityId: p.entityId, add: p.identifiers });
    if (p.website) ops.push({ op: "update", entityId: p.entityId, website: p.website, apply: false });
    if (!ops.length) ops.push({ op: "apply", entityIds: [p.entityId] });
    return ops;
  }
  return [{ op: "create", name: p.canonical, type: p.type, aliases: p.aliases, identifiers: p.identifiers, website: p.website ?? null }];
}

/**
 * Approve drafts as ONE batch (preview with `dryRun`). Marks them approved
 * with the batch id in the same transaction. A failing draft fails the whole
 * approval with its id in the message.
 */
export async function approveProposals(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer;
  ids: number[];
  actor: BatchActor;
  dryRun?: boolean;
}): Promise<{ result: PayeeOpResult; approved: number[] }> {
  const { executor, userId, dek } = opts;
  // Applied in submission order (oldest first), so a failure is predictable.
  const drafts = (await listProposals(executor, userId, dek, { status: "draft", ids: opts.ids })).sort((a, b) => a.id - b.id);
  const missing = opts.ids.filter((id) => !drafts.some((d) => d.id === id));
  if (missing.length) throw new PayeeDirectoryError(`No draft proposal ${missing.map((m) => `#${m}`).join(", ")} (already decided, or not yours).`, "not_found");
  if (!drafts.length) throw new PayeeDirectoryError("Pick at least one proposal.");
  const ops: SingleOp[] = [];
  const labels: string[] = [];
  for (const d of drafts) for (const o of proposalOps(d)) {
    ops.push(o);
    labels.push(`proposal #${d.id} ("${d.canonical}")`);
  }
  const result = await executePayeeOp({
    executor,
    userId,
    dek,
    actor: opts.actor,
    dryRun: opts.dryRun,
    op: { op: "bulk", kind: "approve", ops, aliasSource: "proposal", labels },
    onBatch: async (tx, out) => {
      await tx.execute(sql`
        UPDATE payee_proposals SET status = 'approved', decided_at = NOW(), batch_id = ${out.batchId}
        WHERE user_id = ${userId} AND status = 'draft' AND id IN (${sql.join(drafts.map((d) => sql`${d.id}`), sql`, `)})`);
    },
  });
  return { result, approved: drafts.map((d) => d.id) };
}

export async function rejectProposals(executor: PayeeExecutor, userId: string, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = normalizeDbRows(
    await executor.execute(sql`
      UPDATE payee_proposals SET status = 'rejected', decided_at = NOW()
      WHERE user_id = ${userId} AND status = 'draft' AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      RETURNING id`),
  );
  return rows.length;
}

/** Masked view of a proposal for MCP answers. */
export function proposalOut(p: Proposal) {
  return {
    proposal_id: p.id,
    status: p.status,
    canonical: p.canonical,
    type: p.type,
    ...(p.entityId != null ? { entity_id: p.entityId } : {}),
    aliases: p.aliases,
    identifiers: p.identifiers.map((i) => ({ kind: i.kind, value: maskIdentifier(i.kind, i.value) })),
    ...(p.website ? { website: p.website } : {}),
    reason: p.reason,
    confidence: p.confidence,
    needsDecision: p.needsDecision,
    ...(p.notes.length ? { notes: p.notes } : {}),
    ...(p.batchId != null ? { batch_id: p.batchId } : {}),
  };
}

// ─── review pack ────────────────────────────────────────────────────────────

/**
 * A compact, LLM-friendly picture of what needs attention: unrecognized
 * payees and look-alike clusters with example rows, plus the directory (so
 * the AI can extend an entity instead of duplicating it). Payees already in
 * a pending draft are marked `proposed`.
 */
export function buildReviewPack(o: PayeeOverview, drafts: Proposal[], opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 300);
  const proposedKeys = new Set<string>();
  for (const d of drafts) {
    proposedKeys.add(payeeMatchKey(d.canonical));
    for (const a of d.aliases) if (a.mode === "exact") proposedKeys.add(payeeMatchKey(a.pattern));
  }
  const fmt = (n: number) => Math.round(n * 100) / 100;
  const unrecognized = o.groups
    .filter((g) => g.key && g.entityId == null)
    .slice(0, limit)
    .map((g) => ({
      key: g.key,
      payee: g.name,
      ...(g.spellings.length > 1 ? { spellings: g.spellings.slice(0, 5).map((s) => s.spelling) } : {}),
      count: g.count,
      total: fmt(g.total),
      period: g.firstDate && g.lastDate ? `${g.firstDate}…${g.lastDate}` : null,
      categories: g.categories.slice(0, 2).map((c) => c.name),
      typeGuess: g.type.type,
      ...(g.type.isPerson ? { person: true } : {}),
      ...(g.samples?.length ? { examples: g.samples.map((x) => `${x.date} ${x.amount}${x.currency ? " " + x.currency : ""}${x.category ? " · " + x.category : ""}`) } : {}),
      ...(proposedKeys.has(g.key) ? { proposed: true } : {}),
    }));
  const clusters = o.clusters.slice(0, Math.ceil(limit / 2)).map((c) => ({
    cluster_id: c.id,
    confidence: c.confidence,
    reasons: c.reasons,
    ...(c.needsDecision ? { needsDecision: true } : {}),
    suggestedName: c.suggestedName,
    suggestedType: c.suggestedType.type,
    members: c.groups.map((g) => ({
      payee: g.name,
      count: g.count,
      ...(g.spellings.length > 1 ? { spellings: g.spellings.slice(0, 4).map((s) => s.spelling) } : {}),
      ...(g.entityId != null ? { entity_id: g.entityId } : {}),
    })),
  }));
  return {
    howTo:
      "Propose with op=propose proposals=[{canonical, type, aliases[], identifiers[], reason, confidence 0–1, entity_id? to extend an existing entry}]. Use the exact spellings shown as aliases. Do not group a private person with a merchant. Nothing changes until the user approves.",
    stats: {
      payees: o.groups.filter((g) => g.key).length,
      unrecognized: o.groups.filter((g) => g.key && g.entityId == null).length,
      clusters: o.clusters.length,
      directory: o.directory.length,
      pendingDrafts: drafts.length,
    },
    unrecognized,
    clusters,
    directory: o.directory.slice(0, 300).map((e) => ({ entity_id: e.id, name: e.name, type: e.type, has_website: e.website != null })),
    currency: o.currency,
  };
}
