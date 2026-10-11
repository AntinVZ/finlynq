"use client";

/**
 * Small labels that say which slice of transactions a widget shows.
 *
 * - `ScopeBadge` — on widgets built from transactions (income, spending,
 *   categories…). Shows the scope they were computed with.
 * - `AllAccountsBadge` — on balance-based widgets (net worth, balances…). These
 *   never follow the scope, because an account isn't business or personal;
 *   single transactions are. Shown only while the scope is not "All".
 *
 * Both render nothing in personal usage mode.
 */

import { useViewScope } from "@/components/view-scope-provider";
import { VIEW_SCOPE_LABELS, type ViewScope } from "@/lib/view-scope";
import { cn } from "@/lib/utils";

const BASE =
  "inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-medium leading-none whitespace-nowrap";

export const ALL_ACCOUNTS_HINT =
  "Balances always include every account. Business or personal is marked on single transactions, not on accounts, so balances can't be split.";

export function ScopeBadge({ scope, className }: { scope?: ViewScope; className?: string }) {
  const ctx = useViewScope();
  if (!ctx.businessEnabled) return null;
  const s = scope ?? ctx.scope;
  return (
    <span
      className={cn(
        BASE,
        s === "all" ? "border-border text-muted-foreground" : "border-primary/30 bg-primary/10 text-primary",
        className,
      )}
      title={`Showing ${VIEW_SCOPE_LABELS[s].toLowerCase()} transactions`}
      data-testid="scope-badge"
    >
      {VIEW_SCOPE_LABELS[s]}
    </span>
  );
}

export function AllAccountsBadge({ className }: { className?: string }) {
  const { businessEnabled, scope } = useViewScope();
  if (!businessEnabled || scope === "all") return null;
  return (
    <span
      className={cn(BASE, "border-border text-muted-foreground cursor-help", className)}
      title={ALL_ACCOUNTS_HINT}
      aria-label={`All accounts. ${ALL_ACCOUNTS_HINT}`}
      data-testid="all-accounts-badge"
    >
      All accounts
    </span>
  );
}
