/**
 * Usage mode + global view scope (client-safe, pure).
 *
 * Business features are optional. Two per-user settings rows drive them:
 *
 *   usage_mode = "personal" | "business_too"   (default "personal")
 *   view_scope = "all" | "business" | "personal" (default "all")
 *
 * `view_scope` only means something when `usage_mode` is "business_too"; in
 * personal mode the effective scope is always "all", so a scope left behind
 * from an earlier business period can never quietly hide transactions.
 *
 * The scope values are the same strings as `BusinessFilter`
 * (lib/reports/business-filter.ts), so a scope goes straight onto the wire
 * through `serializeBusinessFilter`. Business-ness is a property of
 * TRANSACTIONS (`transactions.is_business`), not of accounts: flow figures
 * (income, spending, categories) follow the scope, balances do not.
 *
 * MCP tools do NOT read view_scope; they take an explicit `business` argument.
 */
import type { BusinessFilter } from "@/lib/reports/business-filter";

export const USAGE_MODE_KEY = "usage_mode";
export const VIEW_SCOPE_KEY = "view_scope";

export const USAGE_MODES = ["personal", "business_too"] as const;
export type UsageMode = (typeof USAGE_MODES)[number];
export const DEFAULT_USAGE_MODE: UsageMode = "personal";

export const VIEW_SCOPES = ["all", "business", "personal"] as const;
export type ViewScope = (typeof VIEW_SCOPES)[number] & BusinessFilter;
export const DEFAULT_VIEW_SCOPE: ViewScope = "all";

/** Strict parse for API input: the exact value or null (→ 400). */
export function parseUsageMode(value: unknown): UsageMode | null {
  return typeof value === "string" && (USAGE_MODES as readonly string[]).includes(value)
    ? (value as UsageMode)
    : null;
}

/** Strict parse for API input: the exact value or null (→ 400). */
export function parseViewScope(value: unknown): ViewScope | null {
  return typeof value === "string" && (VIEW_SCOPES as readonly string[]).includes(value)
    ? (value as ViewScope)
    : null;
}

/** Stored row value → usage mode; a missing or unknown row reads as the default. */
export function usageModeFromStored(value: string | null | undefined): UsageMode {
  return parseUsageMode(value) ?? DEFAULT_USAGE_MODE;
}

/** Stored row value → view scope; a missing or unknown row reads as the default. */
export function viewScopeFromStored(value: string | null | undefined): ViewScope {
  return parseViewScope(value) ?? DEFAULT_VIEW_SCOPE;
}

/** The scope pages should actually apply: always "all" in personal mode. */
export function effectiveScope(mode: UsageMode, stored: ViewScope): ViewScope {
  return mode === "business_too" ? stored : "all";
}

export const VIEW_SCOPE_LABELS: Record<ViewScope, string> = {
  all: "All",
  business: "Business",
  personal: "Personal",
};
