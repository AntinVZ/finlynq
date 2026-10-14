"use client";

/**
 * Side panel for a payee that is not in the directory yet: total, count,
 * first / last date, top categories and accounts, every spelling, and the
 * two next steps — "Add to directory" and "Show transactions".
 */

import Link from "next/link";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/i18n/format-current";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { needsDecisionBadge, type PayeeGroupRow } from "./payee-ui";
import { PayeeTypeLabel } from "./merchant-type-ui";
import { CounterpartyRequisites } from "@/components/payees/counterparty-requisites";
import { useStudioT } from "./i18n";

export function PayeeDrawer({
  group,
  currency,
  onClose,
  onAdd,
  onExplain,
}: {
  group: PayeeGroupRow;
  currency: string;
  onClose: () => void;
  onAdd: (g: PayeeGroupRow) => void;
  onExplain?: (g: PayeeGroupRow) => void;
}) {
  const t = useStudioT();
  const g = group;
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="break-all pe-6">{g.name}</SheetTitle>
          <SheetDescription>
            <PayeeTypeLabel type={g.type.type} />
            {g.type.isPerson ? " · " : ""}
            {g.type.isPerson && needsDecisionBadge(g.type.reason, t)}
            {` · ${t("explain.notInDirectory")}`}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-4 text-sm">
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-md border p-2">
              <dt className="text-xs text-muted-foreground">{t("drawer.total")}</dt>
              <dd className="font-semibold tabular-nums">{formatCurrency(g.total, currency)}</dd>
            </div>
            <div className="rounded-md border p-2">
              <dt className="text-xs text-muted-foreground">{t("common.transactions")}</dt>
              <dd className="font-semibold tabular-nums">
                {g.count}
                {g.rows > g.count && <span className="ms-1 text-xs font-normal text-muted-foreground">{t("common.otherRows", { n: g.rows - g.count })}</span>}
              </dd>
            </div>
            <div className="rounded-md border p-2">
              <dt className="text-xs text-muted-foreground">{t("common.first")}</dt>
              <dd className="tabular-nums">{formatDate(g.firstDate)}</dd>
            </div>
            <div className="rounded-md border p-2">
              <dt className="text-xs text-muted-foreground">{t("common.lastDate")}</dt>
              <dd className="tabular-nums">{formatDate(g.lastDate)}</dd>
            </div>
          </dl>
          <section>
            <h3 className="text-xs font-medium text-muted-foreground mb-1">{t("drawer.topCategories")}</h3>
            {g.categories.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("drawer.uncategorized")}</p>
            ) : (
              <ul className="space-y-0.5">
                {g.categories.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2">
                    <span className="truncate">{c.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">× {c.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {g.accounts.length > 0 && (
            <section>
              <h3 className="text-xs font-medium text-muted-foreground mb-1">{t("common.accounts")}</h3>
              <p className="text-xs">{g.accounts.map((a) => `${a.name} × ${a.count}`).join(", ")}</p>
            </section>
          )}
          <section>
            <h3 className="text-xs font-medium text-muted-foreground mb-1">{t("suspicious.spellings")}</h3>
            <div className="flex flex-wrap gap-1.5">
              {g.spellings.map((s) => (
                <Badge key={s.spelling} variant="secondary" className="font-normal break-all">
                  {s.spelling} <span className="ms-1 text-muted-foreground">× {s.count}</span>
                </Badge>
              ))}
            </div>
          </section>
          <CounterpartyRequisites payee={g.name} note={g.spellings.slice(1).map((x) => x.spelling).join(" ")} />
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" onClick={() => onAdd(g)}>
              {t("common.addToDirectory")}
            </Button>
            <Link href={buildTxDrillUrl({ search: g.name })}>
              <Button size="sm" variant="outline">{t("common.showTransactions")}</Button>
            </Link>
            {onExplain && (
              <Button size="sm" variant="ghost" onClick={() => onExplain(g)}>
                {t("common.explain")}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
