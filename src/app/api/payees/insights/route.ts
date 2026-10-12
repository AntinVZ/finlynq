/**
 * /api/payees/insights — who the money goes to (Settings → Payees → Insights).
 *
 * GET ?months=1..60 (default 12) &recentDays=7..730 (default 90)
 *   → { topBySpend, topByCount, monthly: { months, series }, newCounterparties,
 *       goneCounterparties, recurring, concentration, totals, currency, … }
 *   Counterparty = a directory entry when the payee resolves to one, else the
 *   payee group. Amounts are in the display currency; "spend" is net outflow.
 *   Read only (lib/payees/insights.ts).
 *
 * GET ?view=merchants [&from=YYYY-MM-DD&to=YYYY-MM-DD] [&entityId=N | &name=…]
 *     [&p1from&p1to&p2from&p2to] [&limit=1..100]
 *   → the eight merchant analyses (P5d, lib/payees/merchant-analytics.ts):
 *     receipt, receiptTrend, change (count vs receipt effect), lifecycle
 *     (new / quiet / returned / churned), regular, multiCategory,
 *     businessPersonal, people — display currency, transactions only,
 *     batched scan with `truncated`. Every parameter optional.
 */
import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { buildPayeeMatcher, loadDirectory } from "@/lib/payees/directory";
import { computePayeeInsights } from "@/lib/payees/insights";
import { loadMerchantAnalytics, makeSliceConverter } from "@/lib/payees/service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateParam = (v: string | null) => (v && DATE_RE.test(v) ? v : null);
const periodParam = (from: string | null, to: string | null) => {
  const f = dateParam(from);
  const t = dateParam(to);
  return f || t ? { from: f ?? "0000-01-01", to: t ?? "9999-12-31" } : undefined;
};

const intParam = (v: string | null, def: number) => {
  const n = Number(v ?? "");
  return Number.isInteger(n) && n > 0 ? n : def;
};

export const GET = apiHandler({ auth: "encryption", raw: true, fallbackMessage: "Failed to load payee insights" }, async ({ request, userId, dek }) => {
  const params = request.nextUrl.searchParams;
  if (params.get("view") === "merchants") {
    const entityId = Number(params.get("entityId") ?? "");
    const limit = Number(params.get("limit") ?? "");
    return NextResponse.json(
      await loadMerchantAnalytics({
        executor: db,
        userId,
        dek,
        period: periodParam(params.get("from"), params.get("to")) ?? null,
        period1: periodParam(params.get("p1from"), params.get("p1to")),
        period2: periodParam(params.get("p2from"), params.get("p2to")),
        entityId: Number.isInteger(entityId) && entityId > 0 ? entityId : undefined,
        name: params.get("name")?.slice(0, 500) || undefined,
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10,
      }),
    );
  }
  const directory = await loadDirectory(db, userId, dek);
  const { currency, convert } = await makeSliceConverter(userId);
  const insights = await computePayeeInsights({
    executor: db,
    userId,
    dek,
    matcher: buildPayeeMatcher(directory),
    convert,
    currency,
    months: intParam(params.get("months"), 12),
    recentDays: intParam(params.get("recentDays"), 90),
  });
  return NextResponse.json(insights);
});
