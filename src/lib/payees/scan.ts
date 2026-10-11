/**
 * Payee scan (Payee Studio): read every table that carries a payee, decrypt
 * it, and aggregate per spelling — never keeping the rows themselves.
 *
 * `payee` is per-row encrypted free text, so SQL can't GROUP BY it (random IV
 * per row) and must never LIKE it. Each table is read in id-ordered pages
 * (keyset, `id > last`), each payee decrypted once, and folded into one
 * {@link SpellingAgg} per distinct spelling: counts per source table, signed
 * amount slices per currency, first / last date, accounts and categories.
 * Memory is bounded by the number of distinct spellings, not rows.
 *
 * Sources and how their payee is stored:
 *   - transactions            user DEK (v1:), legacy plaintext passthrough
 *   - recurring_transactions  user DEK (v1:) or plaintext (encryptOptional)
 *   - staged_transactions     two-tier: 'user' → v1:, 'service' → sv1:
 *   - simplefin_pending_…     two-tier like staged (default 'user')
 *   - bank_transactions       two-tier; READ ONLY — the bank ledger is an
 *                             immutable statement journal and Payee Studio
 *                             never writes it.
 *
 * A value that can't be decrypted (no DEK, wrong key) is counted in
 * `undecryptable` and skipped — never shown as ciphertext, never grouped.
 */
import { sql, type SQL } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { payeeMatchKey } from "./match-key";

/** Anything with Drizzle's `execute` — the web `db`, a transaction, or the MCP `DbLike`. */
export type PayeeExecutor = { execute: (query: SQL) => Promise<unknown> };

export const PAYEE_SOURCES = ["transactions", "recurring", "staged", "pending", "bank"] as const;
export type PayeeSource = (typeof PAYEE_SOURCES)[number];

/** Rows read per page. */
export const PAYEE_SCAN_BATCH = 2_000;
/** Per-table bound: past this many rows the scan of that table stops and says `truncated`. */
export const PAYEE_SCAN_MAX_PER_SOURCE = 250_000;

export type AmountSlice = {
  currency: string | null;
  reportingCurrency: string | null;
  totalAmount: number;
  /** null once any row in the slice had no stored reporting amount. */
  totalReporting: number | null;
};

export type SpellingAgg = {
  /** The payee as stored (decrypted), whitespace-collapsed and trimmed. */
  spelling: string;
  /** `payeeMatchKey(spelling)`. */
  key: string;
  /** Rows per source table. */
  counts: Record<PayeeSource, number>;
  /** Signed amount slices of the `transactions` rows only (other tables mirror them). */
  slices: Map<string, AmountSlice>;
  firstDate: string | null;
  lastDate: string | null;
  /** accountId → transactions count. */
  accounts: Map<number, number>;
  /** categoryId → transactions count. */
  categories: Map<number, number>;
  /** YYYY-MM → slices (transactions only); filled when `withMonths`. */
  months?: Map<string, Map<string, AmountSlice>>;
  /** YYYY-MM → transactions count; filled when `withMonths`. */
  monthCounts?: Map<string, number>;
  /** Transaction dates (unsorted); filled when `withDates`. */
  dates?: string[];
  /** The most recent transactions (date, amount, category); filled when `samplesPerSpelling`. */
  samples?: PayeeSample[];
};

export type PayeeSample = { date: string; amount: number; currency: string | null; categoryId: number | null };

export type PayeeScan = {
  spellings: Map<string, SpellingAgg>;
  scanned: Record<PayeeSource, number>;
  /** Sources whose scan hit the per-source bound with rows left unread. */
  truncated: PayeeSource[];
  undecryptable: number;
};

const zeroCounts = (): Record<PayeeSource, number> => ({ transactions: 0, recurring: 0, staged: 0, pending: 0, bank: 0 });

/** Collapse whitespace and trim: the identity of a spelling. */
export function spellingOf(payee: string | null | undefined): string {
  return (payee ?? "").replace(/\s+/g, " ").trim();
}

/** Add a signed amount to its (currency, reporting currency) slice. */
export function addSlice(
  slices: Map<string, AmountSlice>,
  amount: number,
  currency: string | null,
  reportingAmount: number | null,
  reportingCurrency: string | null,
): void {
  const k = `${currency ?? ""}|${reportingCurrency ?? ""}`;
  let s = slices.get(k);
  if (!s) {
    s = { currency, reportingCurrency, totalAmount: 0, totalReporting: 0 };
    slices.set(k, s);
  }
  s.totalAmount += amount;
  if (s.totalReporting != null) s.totalReporting = reportingAmount == null ? null : s.totalReporting + reportingAmount;
}

/** Merge slice maps (for rolling spellings up into groups). */
export function mergeSlices(into: Map<string, AmountSlice>, from: Map<string, AmountSlice>): void {
  for (const [k, s] of from) {
    const t = into.get(k);
    if (!t) {
      into.set(k, { ...s });
      continue;
    }
    t.totalAmount += s.totalAmount;
    t.totalReporting = t.totalReporting == null || s.totalReporting == null ? null : t.totalReporting + s.totalReporting;
  }
}

/**
 * Decode one stored payee. `tier` is the row's `encryption_tier` for the
 * two-tier tables, or null for the user-DEK-only ones. Returns `undefined`
 * when the value can't be read (caller counts it as undecryptable).
 */
export function decodeStoredPayee(stored: unknown, tier: string | null, dek: Buffer | null): string | undefined {
  if (stored == null) return "";
  const v = String(stored);
  if (v === "") return "";
  if (v.startsWith("sv1:")) {
    try {
      return decryptStaged(v) ?? "";
    } catch {
      return undefined;
    }
  }
  if (v.startsWith("v1:")) {
    if (!dek) return undefined;
    const out = tryDecryptField(dek, v, "payee-scan");
    return out == null ? undefined : out;
  }
  // Legacy plaintext (or a service-tier row with no PF_STAGING_KEY in dev).
  void tier;
  return v;
}

type SourceSpec = {
  source: PayeeSource;
  /** One page after `afterId` (text compare for uuid / text ids, numeric for serial). */
  page: (userId: string, afterId: string | number | null, size: number) => SQL;
  numericId: boolean;
};

const SOURCES: Record<PayeeSource, SourceSpec> = {
  transactions: {
    source: "transactions",
    numericId: true,
    page: (userId, after, size) => sql`
      SELECT id, date, amount, currency, reporting_amount, reporting_currency, account_id, category_id, payee, NULL AS encryption_tier
      FROM transactions
      WHERE user_id = ${userId} ${after != null ? sql`AND id > ${Number(after)}` : sql``}
      ORDER BY id LIMIT ${size}`,
  },
  recurring: {
    source: "recurring",
    numericId: true,
    page: (userId, after, size) => sql`
      SELECT id, next_date AS date, amount, NULL AS currency, account_id, category_id, payee, NULL AS encryption_tier
      FROM recurring_transactions
      WHERE user_id = ${userId} ${after != null ? sql`AND id > ${Number(after)}` : sql``}
      ORDER BY id LIMIT ${size}`,
  },
  staged: {
    source: "staged",
    numericId: false,
    page: (userId, after, size) => sql`
      SELECT id, date, amount, currency, NULL AS account_id, NULL AS category_id, payee, encryption_tier
      FROM staged_transactions
      WHERE user_id = ${userId} ${after != null ? sql`AND id > ${String(after)}` : sql``}
      ORDER BY id LIMIT ${size}`,
  },
  pending: {
    source: "pending",
    numericId: false,
    page: (userId, after, size) => sql`
      SELECT id::text AS id, date, amount, currency, account_id, NULL AS category_id, payee, encryption_tier
      FROM simplefin_pending_transactions
      WHERE user_id = ${userId} ${after != null ? sql`AND id::text > ${String(after)}` : sql``}
      ORDER BY id::text LIMIT ${size}`,
  },
  bank: {
    source: "bank",
    numericId: false,
    page: (userId, after, size) => sql`
      SELECT id::text AS id, date, amount, currency, account_id, NULL AS category_id, payee, encryption_tier
      FROM bank_transactions
      WHERE user_id = ${userId} ${after != null ? sql`AND id::text > ${String(after)}` : sql``}
      ORDER BY id::text LIMIT ${size}`,
  },
};

/**
 * Scan payees across `sources` (default: all five) and aggregate per
 * spelling. Keyset-paged; nothing but the aggregates is kept in memory.
 */
export async function scanPayees(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  sources?: readonly PayeeSource[];
  batchSize?: number;
  maxPerSource?: number;
  /** Keep per-month slices / counts (insights). */
  withMonths?: boolean;
  /** Keep transaction dates per spelling (recurrence detection). */
  withDates?: boolean;
  /** Keep the N most recent transactions per spelling as examples (AI review). */
  samplesPerSpelling?: number;
}): Promise<PayeeScan> {
  const { executor, userId, dek } = opts;
  const batchSize = Math.max(1, opts.batchSize ?? PAYEE_SCAN_BATCH);
  const maxPerSource = opts.maxPerSource ?? PAYEE_SCAN_MAX_PER_SOURCE;
  const out: PayeeScan = { spellings: new Map(), scanned: zeroCounts(), truncated: [], undecryptable: 0 };

  for (const source of opts.sources ?? PAYEE_SOURCES) {
    const spec = SOURCES[source];
    let after: string | number | null = null;
    for (;;) {
      const size = Math.min(batchSize, maxPerSource - out.scanned[source]);
      if (size <= 0) {
        const probe = normalizeDbRows(await executor.execute(spec.page(userId, after, 1)));
        if (probe.length > 0) out.truncated.push(source);
        break;
      }
      const page: Array<Record<string, unknown>> = normalizeDbRows<Record<string, unknown>>(
        await executor.execute(spec.page(userId, after, size)),
      );
      out.scanned[source] += page.length;
      for (const r of page) {
        after = spec.numericId ? Number(r.id) : String(r.id);
        const plain = decodeStoredPayee(r.payee, r.encryption_tier == null ? null : String(r.encryption_tier), dek);
        if (plain === undefined) {
          out.undecryptable++;
          continue;
        }
        addRow(out.spellings, source, plain, r, opts);
      }
      if (page.length < size) break;
    }
  }
  return out;
}

function addRow(
  spellings: Map<string, SpellingAgg>,
  source: PayeeSource,
  plain: string,
  r: Record<string, unknown>,
  opts: { withMonths?: boolean; withDates?: boolean; samplesPerSpelling?: number },
): void {
  const spelling = spellingOf(plain);
  let agg = spellings.get(spelling);
  if (!agg) {
    agg = {
      spelling,
      key: payeeMatchKey(spelling),
      counts: zeroCounts(),
      slices: new Map(),
      firstDate: null,
      lastDate: null,
      accounts: new Map(),
      categories: new Map(),
      ...(opts.withMonths ? { months: new Map(), monthCounts: new Map() } : {}),
      ...(opts.withDates ? { dates: [] } : {}),
      ...(opts.samplesPerSpelling ? { samples: [] } : {}),
    };
    spellings.set(spelling, agg);
  }
  agg.counts[source]++;
  const date = r.date == null ? "" : String(r.date).slice(0, 10);
  if (date && source !== "recurring") {
    if (agg.firstDate == null || date < agg.firstDate) agg.firstDate = date;
    if (agg.lastDate == null || date > agg.lastDate) agg.lastDate = date;
  }
  if (source !== "transactions") return;
  const amount = Number(r.amount ?? 0) || 0;
  const currency = r.currency == null ? null : String(r.currency);
  const repAmount = r.reporting_amount == null ? null : Number(r.reporting_amount);
  const repCurrency = r.reporting_currency == null ? null : String(r.reporting_currency);
  addSlice(agg.slices, amount, currency, repAmount, repCurrency);
  if (r.account_id != null) {
    const id = Number(r.account_id);
    agg.accounts.set(id, (agg.accounts.get(id) ?? 0) + 1);
  }
  if (r.category_id != null) {
    const id = Number(r.category_id);
    agg.categories.set(id, (agg.categories.get(id) ?? 0) + 1);
  }
  if (agg.months && agg.monthCounts && date) {
    const month = date.slice(0, 7);
    let m = agg.months.get(month);
    if (!m) agg.months.set(month, (m = new Map()));
    addSlice(m, amount, currency, repAmount, repCurrency);
    agg.monthCounts.set(month, (agg.monthCounts.get(month) ?? 0) + 1);
  }
  if (agg.dates && date) agg.dates.push(date);
  if (agg.samples && opts.samplesPerSpelling) {
    agg.samples.push({ date, amount, currency, categoryId: r.category_id == null ? null : Number(r.category_id) });
    if (agg.samples.length > opts.samplesPerSpelling) {
      // Drop the oldest: keep the most recent N.
      let oldest = 0;
      for (let i = 1; i < agg.samples.length; i++) if (agg.samples[i].date < agg.samples[oldest].date) oldest = i;
      agg.samples.splice(oldest, 1);
    }
  }
}

/** Decrypted account and category names for display (`id → name`). */
export async function loadPayeeNameMaps(
  executor: PayeeExecutor,
  userId: string,
  dek: Buffer | null,
): Promise<{ accounts: Map<number, string>; categories: Map<number, string> }> {
  const accounts = new Map<number, string>();
  const categories = new Map<number, string>();
  for (const r of normalizeDbRows<{ id: unknown; name_ct: unknown }>(
    await executor.execute(sql`SELECT id, name_ct FROM accounts WHERE user_id = ${userId}`),
  )) {
    accounts.set(Number(r.id), decryptName(r.name_ct == null ? null : String(r.name_ct), dek, null) ?? `#${Number(r.id)}`);
  }
  for (const r of normalizeDbRows<{ id: unknown; name_ct: unknown }>(
    await executor.execute(sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`),
  )) {
    categories.set(Number(r.id), decryptName(r.name_ct == null ? null : String(r.name_ct), dek, null) ?? `#${Number(r.id)}`);
  }
  return { accounts, categories };
}
