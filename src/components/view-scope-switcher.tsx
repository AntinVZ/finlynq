"use client";

/**
 * All / Business / Personal controls.
 *
 * - `ScopeSegmented`: the bare three-button control (also used by pages that
 *   override the scope locally).
 * - `ViewScopeBar`: the global switcher in the app header. Renders nothing
 *   unless the usage mode is "business_too".
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useViewScope } from "@/components/view-scope-provider";
import { VIEW_SCOPES, VIEW_SCOPE_LABELS, type ViewScope } from "@/lib/view-scope";

export function ScopeSegmented({
  value,
  onChange,
  ariaLabel = "Show business, personal or all transactions",
  disabled,
}: {
  value: ViewScope;
  onChange: (scope: ViewScope) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-md shadow-xs">
      {VIEW_SCOPES.map((s, i) => (
        <Button
          key={s}
          type="button"
          variant={value === s ? "default" : "outline"}
          size="sm"
          aria-pressed={value === s}
          disabled={disabled}
          onClick={() => onChange(s)}
          className={`h-8 ${i > 0 ? "-ml-px rounded-l-none" : ""} ${i < VIEW_SCOPES.length - 1 ? "rounded-r-none" : ""}`}
        >
          {VIEW_SCOPE_LABELS[s]}
        </Button>
      ))}
    </div>
  );
}

export function ViewScopeBar() {
  const { businessEnabled, isLoading, scope, setScope } = useViewScope();
  const [error, setError] = useState<string | null>(null);

  if (isLoading || !businessEnabled) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <span className="text-xs text-muted-foreground">Showing</span>
      <ScopeSegmented
        value={scope}
        onChange={(next) => {
          setError(null);
          setScope(next).catch(() => setError("Couldn't save. Try again."));
        }}
      />
    </div>
  );
}
