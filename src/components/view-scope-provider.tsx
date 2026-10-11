"use client";

/**
 * ViewScopeProvider — the user's usage mode and the global
 * All / Business / Personal view scope.
 *
 *   const { usageMode, scope, setScope, setUsageMode } = useViewScope();
 *
 * `scope` is the EFFECTIVE scope (always "all" in personal mode); `storedScope`
 * is what the switcher last saved. Both setters update optimistically and
 * persist through PUT /api/settings/usage-mode and /api/settings/view-scope,
 * rolling back on failure. Rules live in lib/view-scope.ts.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_USAGE_MODE,
  DEFAULT_VIEW_SCOPE,
  effectiveScope,
  usageModeFromStored,
  viewScopeFromStored,
  type UsageMode,
  type ViewScope,
} from "@/lib/view-scope";

type ViewScopeContextValue = {
  usageMode: UsageMode;
  /** true when usage mode is "business_too" — show business UI. */
  businessEnabled: boolean;
  /** The scope pages should apply. */
  scope: ViewScope;
  /** The scope as saved, regardless of usage mode. */
  storedScope: ViewScope;
  isLoading: boolean;
  setUsageMode: (mode: UsageMode) => Promise<void>;
  setScope: (scope: ViewScope) => Promise<void>;
};

const ViewScopeContext = createContext<ViewScopeContextValue | null>(null);

async function putSetting(path: string, body: Record<string, string>): Promise<void> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `Failed to save (HTTP ${res.status})`);
  }
}

export function ViewScopeProvider({ children }: { children: ReactNode }) {
  const [usageMode, setUsageModeState] = useState<UsageMode>(DEFAULT_USAGE_MODE);
  const [storedScope, setStoredScope] = useState<ViewScope>(DEFAULT_VIEW_SCOPE);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const read = (path: string) =>
      fetch(path)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    Promise.all([read("/api/settings/usage-mode"), read("/api/settings/view-scope")])
      .then(([mode, scope]) => {
        if (cancelled) return;
        setUsageModeState(usageModeFromStored(mode?.usageMode));
        setStoredScope(viewScopeFromStored(scope?.viewScope));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setUsageMode = useCallback(async (mode: UsageMode) => {
    const previous = usageMode;
    setUsageModeState(mode);
    try {
      await putSetting("/api/settings/usage-mode", { usageMode: mode });
    } catch (err) {
      setUsageModeState(previous);
      throw err;
    }
  }, [usageMode]);

  const setScope = useCallback(async (scope: ViewScope) => {
    const previous = storedScope;
    setStoredScope(scope);
    try {
      await putSetting("/api/settings/view-scope", { viewScope: scope });
    } catch (err) {
      setStoredScope(previous);
      throw err;
    }
  }, [storedScope]);

  return (
    <ViewScopeContext.Provider
      value={{
        usageMode,
        businessEnabled: usageMode === "business_too",
        scope: effectiveScope(usageMode, storedScope),
        storedScope,
        isLoading,
        setUsageMode,
        setScope,
      }}
    >
      {children}
    </ViewScopeContext.Provider>
  );
}

export function useViewScope(): ViewScopeContextValue {
  const ctx = useContext(ViewScopeContext);
  if (!ctx) {
    // Outside a provider (tests, static pages): personal mode, everything shown.
    return {
      usageMode: DEFAULT_USAGE_MODE,
      businessEnabled: false,
      scope: DEFAULT_VIEW_SCOPE,
      storedScope: DEFAULT_VIEW_SCOPE,
      isLoading: false,
      setUsageMode: async () => {
        throw new Error("useViewScope called outside ViewScopeProvider");
      },
      setScope: async () => {
        throw new Error("useViewScope called outside ViewScopeProvider");
      },
    };
  }
  return ctx;
}
