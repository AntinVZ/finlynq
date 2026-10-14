"use client";

/**
 * Small shared pieces for the Merchants section (P8 stage 1):
 *  - <HelpHint> — a (?) next to a term; the explanation shows on hover,
 *    focus and tap (a native <details> on touch, a title elsewhere).
 *  - <ListSkeleton> — placeholder rows while a list loads.
 *  - <EmptyState> — "0 rows" always says why (`reason`) and what to do.
 *  - <LoadError> — an error with a "Try again" button.
 */

import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export function HelpHint({ text, className }: { text: string; className?: string }) {
  return (
    <details className={cn("group relative inline-block align-middle", className)}>
      <summary
        className="inline-flex cursor-help list-none items-center text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
        aria-label={text}
        title={text}
      >
        <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
      </summary>
      <span
        role="note"
        className="absolute start-0 top-5 z-20 w-64 rounded-md border bg-popover p-2 text-xs font-normal text-popover-foreground shadow-md"
      >
        {text}
      </span>
    </details>
  );
}

export function ListSkeleton({ rows = 5, label }: { rows?: number; label?: string }) {
  const t = useT();
  return (
    <ul className="space-y-2" aria-busy="true" aria-label={label ?? t("common.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
      ))}
    </ul>
  );
}

export function EmptyState({ reason, action }: { reason: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-empty-reason>
      <p>{reason}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 p-3 text-sm" role="alert">
      <span className="text-destructive">{message}</span>
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
