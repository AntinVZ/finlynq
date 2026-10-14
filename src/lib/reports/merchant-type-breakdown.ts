/**
 * Reports → Trends grouped by merchant type (P8 stage 2). SQL can't group
 * by it: the payee is encrypted and the type lives on the Merchants
 * directory entry. So the rows of the period are read (income / expense
 * categories only, like the other groupings), each payee is resolved through
 * the directory matcher, and the sums go to the entry's merchant type — «Кафе, ресторани, бари · Кафе»,
 * or «Без типу» when the payee isn't in the
 * directory or has no type. Read only.
 */
import { sql, type SQL } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { decodeStoredPayee, spellingOf, type PayeeExecutor } from "@/lib/payees/scan";
import type { PayeeMatcher } from "@/lib/payees/directory";
import type { MerchantType } from "@/lib/payees/merchant-types";

export type TypeBreakdownRow = {
  period: string;
  categoryType: "I" | "E";
  /** The merchant type, or null = no type (not in the directory, or untyped). */
  typeId: number | null;
  /** Display label of that type, or null = no type. */
  label: string | null;
  currency: string | null;
  reportingCurrency: string | null;
  amount: number;
  reportingAmount: number | null;
};

const MAX_ROWS = 100_000;

export async function loadMerchantTypeRows(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  matcher: PayeeMatcher;
  types: readonly MerchantType[];
  /** The period expression (YYYY-MM, quarter, …) over `transactions.date` (tables are not aliased). */
  periodSql: SQL;
  where: SQL;
  label: (t: MerchantType) => string;
}): Promise<{ rows: TypeBreakdownRow[]; truncated: boolean }> {
  const raw = normalizeDbRows<Record<string, unknown>>(
    await opts.executor.execute(sql`
      SELECT ${opts.periodSql} AS period, categories.type AS category_type, transactions.payee, transactions.currency,
             transactions.reporting_currency, transactions.amount, transactions.reporting_amount
      FROM transactions LEFT JOIN categories ON categories.id = transactions.category_id
      WHERE ${opts.where}
      LIMIT ${MAX_ROWS + 1}`),
  );
  const typeById = new Map(opts.types.filter((t) => t.id != null).map((t) => [t.id!, t]));
  const typeOf = new Map<string, MerchantType | null>();
  const rows: TypeBreakdownRow[] = [];
  for (const r of raw.slice(0, MAX_ROWS)) {
    const ct = String(r.category_type ?? "");
    if (ct !== "I" && ct !== "E") continue;
    const payee = spellingOf(decodeStoredPayee(r.payee, null, opts.dek) ?? "");
    let type = typeOf.get(payee);
    if (type === undefined) {
      const m = payee ? opts.matcher.match(payee) : { kind: "none" as const };
      const typeId = m.kind === "match" ? (opts.matcher.entity(m.entityId)?.merchantTypeId ?? null) : null;
      type = (typeId != null ? typeById.get(typeId) : undefined) ?? null;
      if (typeOf.size < 50_000) typeOf.set(payee, type);
    }
    rows.push({
      period: String(r.period),
      categoryType: ct,
      typeId: type?.id ?? null,
      label: type ? opts.label(type) : null,
      currency: r.currency == null ? null : String(r.currency),
      reportingCurrency: r.reporting_currency == null ? null : String(r.reporting_currency),
      amount: Number(r.amount ?? 0),
      reportingAmount: r.reporting_amount == null ? null : Number(r.reporting_amount),
    });
  }
  return { rows, truncated: raw.length > MAX_ROWS };
}
