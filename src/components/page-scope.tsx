"use client";

/**
 * Per-page override of the global All / Business / Personal scope.
 *
 *   const pageScope = usePageScope();
 *   fetch(`/api/reports?...&business=${serializeBusinessFilter(pageScope.scope)}`)
 *   <PageScopeControl {...pageScope} />
 *
 * The page starts on the global scope (useViewScope) and follows it until the
 * user picks a different value here; from then on the page keeps its own value,
 * shows "Scope changed on this page" and offers "Reset to global". The override
 * is page state only: it is never saved and is gone on the next visit. Picking
 * the same value as the global scope clears the override. In personal usage
 * mode there is no override and the scope is always "all".
 */

import { useCallback, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useViewScope } from "@/components/view-scope-provider";
import { ScopeSegmented } from "@/components/view-scope-switcher";
import { VIEW_SCOPE_LABELS, type ViewScope } from "@/lib/view-scope";

export type PageScope = {
  /** The scope this page applies. */
  scope: ViewScope;
  /** The global scope it would otherwise follow. */
  globalScope: ViewScope;
  overridden: boolean;
  businessEnabled: boolean;
  /** true until the global settings have loaded — hold fetches until then. */
  isLoading: boolean;
  setPageScope: (scope: ViewScope) => void;
  resetToGlobal: () => void;
};

/** Pure resolution, exported for tests. */
export function resolvePageScope(
  businessEnabled: boolean,
  globalScope: ViewScope,
  override: ViewScope | null,
): { scope: ViewScope; overridden: boolean } {
  if (!businessEnabled) return { scope: "all", overridden: false };
  if (override == null || override === globalScope) return { scope: globalScope, overridden: false };
  return { scope: override, overridden: true };
}

export function usePageScope(): PageScope {
  const { scope: globalScope, businessEnabled, isLoading } = useViewScope();
  const [override, setOverride] = useState<ViewScope | null>(null);
  const { scope, overridden } = resolvePageScope(businessEnabled, globalScope, override);

  const setPageScope = useCallback(
    (next: ViewScope) => setOverride(next === globalScope ? null : next),
    [globalScope],
  );
  const resetToGlobal = useCallback(() => setOverride(null), []);

  return { scope, globalScope, overridden, businessEnabled, isLoading, setPageScope, resetToGlobal };
}

export function PageScopeControl({
  scope,
  globalScope,
  overridden,
  businessEnabled,
  setPageScope,
  resetToGlobal,
  label = "Transactions",
}: PageScope & { label?: string }) {
  if (!businessEnabled) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <span className="text-xs text-muted-foreground mb-1 block">{label}</span>
        <ScopeSegmented value={scope} onChange={setPageScope} />
      </div>
      {overridden && (
        <div className="flex items-center gap-1.5 pb-0.5" data-testid="page-scope-override">
          <span
            className="text-[11px] text-amber-700 dark:text-amber-400"
            title={`The rest of the app shows ${VIEW_SCOPE_LABELS[globalScope]}.`}
          >
            Scope changed on this page
          </span>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={resetToGlobal}>
            <RotateCcw className="h-3 w-3 mr-1" />
            Reset to global
          </Button>
        </div>
      )}
    </div>
  );
}
