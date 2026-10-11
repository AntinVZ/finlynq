/**
 * Payee Studio entry points shared by the web routes (`/api/payees…`) and the
 * MCP `manage_payees` tool, so both see the same groups, clusters and totals.
 */
import { getDisplayCurrency, getRateMap } from "@/lib/fx-service";
import { convertReportingSlice } from "@/lib/fx/reporting-amount";
import { buildPayeeClusters, buildPayeeGroups, type EntityResolver, type PayeeCluster, type PayeeGroup } from "./overview";
import { loadPayeeNameMaps, scanPayees, type AmountSlice, type PayeeExecutor, type PayeeScan, type PayeeSource } from "./scan";

/** Slices → display-currency sum, the way the dashboard converts flows. */
export async function makeSliceConverter(
  userId: string,
  currency?: string,
): Promise<{ currency: string; convert: (slices: AmountSlice[]) => number }> {
  const display = currency ?? (await getDisplayCurrency(userId));
  const rateMap = await getRateMap(display, userId);
  return {
    currency: display,
    convert: (slices) => slices.reduce((sum, s) => sum + convertReportingSlice(s, display, rateMap), 0),
  };
}

export type PayeeOverview = {
  groups: PayeeGroup[];
  clusters: PayeeCluster[];
  currency: string;
  scanned: PayeeScan["scanned"];
  truncated: PayeeSource[];
  undecryptable: number;
};

/** Scan, group and cluster every payee of a user. */
export async function loadPayeeOverview(opts: {
  executor: PayeeExecutor;
  userId: string;
  dek: Buffer | null;
  currency?: string;
  resolveEntity?: EntityResolver;
}): Promise<PayeeOverview> {
  const { executor, userId, dek } = opts;
  const scan = await scanPayees({ executor, userId, dek });
  const names = await loadPayeeNameMaps(executor, userId, dek);
  const { currency, convert } = await makeSliceConverter(userId, opts.currency);
  const groups = buildPayeeGroups(scan, {
    accountNames: names.accounts,
    categoryNames: names.categories,
    convert,
    resolveEntity: opts.resolveEntity,
  });
  return {
    groups,
    clusters: buildPayeeClusters(groups),
    currency,
    scanned: scan.scanned,
    truncated: scan.truncated,
    undecryptable: scan.undecryptable,
  };
}
