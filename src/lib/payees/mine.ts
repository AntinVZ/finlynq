/**
 * Requisite mining (Payee Studio P5f) — on request only (a button, an MCP
 * call), never on a schedule.
 *
 * Reads `transactions` (payee + note) and `bank_transactions` (payee + note
 * — the statement text; read only, never written), decrypts each row and
 * pulls requisites out with ./requisites.ts: IBANs, card masks / full card
 * numbers (kept as the LAST 4 digits only) and SIGNED tax codes. Results are
 * grouped per (counterparty, requisite):
 *
 *   - `suggestions`: a requisite seen in a counterparty's rows that its
 *     directory entry doesn't have yet (or a payee not in the directory);
 *   - `links`: a STRONG requisite (IBAN, ІПН, ЄДРПОУ) already in the
 *     directory under entry X, found in rows whose payee resolves elsewhere —
 *     a suggestion to add that spelling as an alias of X (never applied by
 *     itself). A card's last 4 digits are too weak for this.
 *
 * Everything returned is masked (IBAN edges, ІПН last 2, card last 4); an
 * example row is shown through `maskSensitiveText`. The full values stay in
 * memory and are only used to store DRAFT proposals (`proposeMined`), which
 * a person approves on the AI review page. Bounded scan: MINE_MAX_ROWS per
 * table, then `truncated`.
 */
import { createHash } from "crypto";
import { sql, type SQL } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { payeeMatchKey } from "./match-key";
import { decodeStoredPayee, spellingOf, type PayeeExecutor } from "./scan";
import { extractRequisites, maskSensitiveText, type RequisiteKind } from "./requisites";
import { maskIdentifier, type PayeeEntity, type PayeeMatcher } from "./directory";
import { saveProposals, type ProposalInput } from "./proposals";

export const MINE_BATCH = 2_000;
export const MINE_MAX_ROWS = 250_000;
const STRONG: ReadonlySet<RequisiteKind> = new Set(["iban", "tax_id", "edrpou"]);

export type MinedSuggestion = {
  /** Opaque id of this suggestion (stable while the data is unchanged). */
  ref: string;
  counterparty: { entityId: number | null; name: string; key: string };
  kind: RequisiteKind;
  masked: string;
  /** Check digits pass (IBAN / ІПН / ЄДРПОУ); cards: true. */
  valid: boolean;
  via: "iban" | "card_mask" | "card_full" | "signed_code";
  rows: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Other directory entries that already carry this requisite. */
  ownedBy: Array<{ id: number; name: string }>;
  example: string;
  source: Array<"transactions" | "bank">;
};

export type MinedLink = {
  ref: string;
  payee: string;
  entity: { id: number; name: string };
  via: string;
  rows: number;
};

export type MineReport = {
  suggestions: MinedSuggestion[];
  links: MinedLink[];
  scanned: { transactions: number; bank: number };
  truncated: boolean;
};

type Internal = { s: MinedSuggestion; value: string };

const PAGES: Record<"transactions" | "bank", (userId: string, after: string | null, size: number) => SQL> = {
  transactions: (userId, after, size) => sql`
    SELECT id, date, payee, note, NULL AS tier FROM transactions
    WHERE user_id = ${userId} ${after != null ? sql`AND id > ${Number(after)}` : sql``} ORDER BY id LIMIT ${size}`,
  bank: (userId, after, size) => sql`
    SELECT id::text AS id, date, payee, note, encryption_tier AS tier FROM bank_transactions
    WHERE user_id = ${userId} ${after != null ? sql`AND id::text > ${after}` : sql``} ORDER BY id::text LIMIT ${size}`,
};

export async function mineIdentifiers(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  matcher: PayeeMatcher;
  directory: PayeeEntity[];
  limit?: number;
  maxRows?: number;
}): Promise<MineReport & { internal: Map<string, Internal>; linkValues: Map<string, { payee: string; entityId: number }> }> {
  const { executor, userId, dek, matcher, directory } = opts;
  const maxRows = opts.maxRows ?? MINE_MAX_ROWS;
  const owners = new Map<string, Array<{ id: number; name: string }>>();
  for (const e of directory) for (const i of e.identifiers) {
    const k = `${i.kind}:${i.value}`;
    const list = owners.get(k) ?? [];
    list.push({ id: e.id, name: e.name });
    owners.set(k, list);
  }
  const found = new Map<string, Internal>();
  const links = new Map<string, MinedLink>();
  const linkValues = new Map<string, { payee: string; entityId: number }>();
  const scanned = { transactions: 0, bank: 0 };
  let truncated = false;
  const ref = (s: string) => "r_" + createHash("sha256").update(`${userId}\u0000${s}`).digest("base64url").slice(0, 16);

  for (const table of ["transactions", "bank"] as const) {
    let after: string | null = null;
    for (;;) {
      const size = Math.min(MINE_BATCH, maxRows - scanned[table]);
      if (size <= 0) {
        truncated = truncated || normalizeDbRows(await executor.execute(PAGES[table](userId, after, 1))).length > 0;
        break;
      }
      const page: Array<Record<string, unknown>> = normalizeDbRows<Record<string, unknown>>(await executor.execute(PAGES[table](userId, after, size)));
      scanned[table] += page.length;
      for (const r of page) {
        after = String(r.id);
        const tier = r.tier == null ? null : String(r.tier);
        const payee = decodeStoredPayee(r.payee, tier, dek);
        const note = decodeStoredPayee(r.note, tier, dek);
        if (payee === undefined) continue;
        const spelling = spellingOf(payee);
        const reqs = [...extractRequisites(payee), ...extractRequisites(note ?? "")];
        if (!reqs.length) continue;
        const key = payeeMatchKey(spelling);
        const m = spelling ? matcher.match(spelling) : { kind: "none" as const };
        const cp = m.kind === "match" ? { entityId: m.entityId, name: m.name, key } : { entityId: null, name: spelling || "(no payee)", key };
        const date = r.date == null ? null : String(r.date).slice(0, 10);
        for (const q of reqs) {
          const own = owners.get(`${q.kind}:${q.value}`) ?? [];
          // Strong requisite owned by another entry than the one the payee resolves to → link suggestion.
          if (STRONG.has(q.kind) && own.length === 1 && own[0].id !== cp.entityId && spelling) {
            const lk = `${spelling}\u0000${own[0].id}`;
            const l = links.get(lk);
            if (l) l.rows++;
            else {
              const id = ref(`link\u0000${lk}`);
              links.set(lk, { ref: id, payee: spelling, entity: own[0], via: `${q.kind} ${q.masked}`, rows: 1 });
              linkValues.set(id, { payee: spelling, entityId: own[0].id });
            }
            continue;
          }
          if (cp.entityId != null && own.some((o) => o.id === cp.entityId)) continue; // already known
          const k = `${cp.entityId ?? "k:" + cp.key}\u0000${q.kind}:${q.value}`;
          let it = found.get(k);
          if (!it) {
            it = {
              value: q.value,
              s: {
                ref: ref(k),
                counterparty: cp,
                kind: q.kind,
                masked: q.kind === "edrpou" ? q.value : maskIdentifier(q.kind, q.value),
                valid: q.valid,
                via: q.via,
                rows: 0,
                firstDate: null,
                lastDate: null,
                ownedBy: own,
                example: maskSensitiveText(`${spelling}${note ? " · " + note : ""}`).slice(0, 160),
                source: [],
              },
            };
            found.set(k, it);
          }
          it.s.rows++;
          if (date && (!it.s.firstDate || date < it.s.firstDate)) it.s.firstDate = date;
          if (date && (!it.s.lastDate || date > it.s.lastDate)) it.s.lastDate = date;
          if (!it.s.source.includes(table)) it.s.source.push(table);
        }
      }
      if (page.length < size) break;
    }
  }
  const limit = opts.limit ?? 200;
  const suggestions = [...found.values()]
    .map((x) => x.s)
    .sort((a, b) => Number(STRONG.has(b.kind)) - Number(STRONG.has(a.kind)) || b.rows - a.rows)
    .slice(0, limit);
  return {
    suggestions,
    links: [...links.values()].sort((a, b) => b.rows - a.rows).slice(0, limit),
    scanned,
    truncated,
    internal: found,
    linkValues,
  };
}

/** Public view of a mining run (no full values, no internals). */
export function mineReportOut(r: Awaited<ReturnType<typeof mineIdentifiers>>): MineReport {
  return { suggestions: r.suggestions, links: r.links, scanned: r.scanned, truncated: r.truncated };
}

/**
 * Store chosen mined suggestions as DRAFT proposals (nothing in the
 * directory changes): requisites for an entry → `{ entityId, identifiers }`;
 * for a payee not in the directory → a new-entry draft named after it; a link
 * → `{ entityId, aliases: [spelling] }`. A person approves them on the AI
 * review page (or MCP op=approve).
 */
export async function proposeMined(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer;
  report: Awaited<ReturnType<typeof mineIdentifiers>>;
  refs: string[];
  source?: string;
}) {
  const { report } = opts;
  const byRef = new Map([...report.internal.values()].map((x) => [x.s.ref, x]));
  const grouped = new Map<string, ProposalInput>();
  const missing: string[] = [];
  for (const r of opts.refs) {
    const link = report.linkValues.get(r);
    if (link) {
      const e = report.links.find((l) => l.ref === r)!;
      grouped.set(`link:${r}`, {
        canonical: e.entity.name,
        entityId: link.entityId,
        aliases: [link.payee],
        reason: `“${link.payee}” rows mention ${e.via}, a requisite of “${e.entity.name}”.`,
        confidence: 0.8,
      });
      continue;
    }
    const it = byRef.get(r);
    if (!it) {
      missing.push(r);
      continue;
    }
    const cp = it.s.counterparty;
    const gk = cp.entityId != null ? `e:${cp.entityId}` : `k:${cp.key}`;
    const p = grouped.get(gk) ?? {
      canonical: cp.name,
      ...(cp.entityId != null ? { entityId: cp.entityId } : { aliases: [] }),
      identifiers: [],
      reason: "Found in your transactions' payee / note / bank statement text.",
      confidence: 0.6,
    };
    p.identifiers = [...(p.identifiers ?? []), { kind: it.s.kind, value: it.value }];
    if (it.s.kind !== "card_last4") p.confidence = 0.85;
    grouped.set(gk, p);
  }
  const saved = grouped.size ? await saveProposals({ executor: opts.executor, userId: opts.userId, dek: opts.dek, proposals: [...grouped.values()], source: opts.source ?? "mine" }) : { saved: [], rejected: [] };
  return { ...saved, missing };
}
