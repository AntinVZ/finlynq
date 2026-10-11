/**
 * Shared types and small renderers for the Payee Studio pages.
 */
import { Badge } from "@/components/ui/badge";

export type NamedCount = { id: number; name: string; count: number };
export type TypeGuess = { type: string; confidence: number; isPerson: boolean; reason: string };

export type PayeeGroupRow = {
  key: string;
  name: string;
  suggestedName: string;
  spellings: Array<{ spelling: string; count: number }>;
  count: number;
  rows: number;
  sources: Record<string, number>;
  firstDate: string | null;
  lastDate: string | null;
  accounts: NamedCount[];
  categories: NamedCount[];
  total: number;
  noisy: boolean;
  type: TypeGuess;
  entityId: number | null;
  entityName: string | null;
};

export type PayeeClusterRow = {
  id: string;
  keys: string[];
  confidence: number;
  reasons: string[];
  needsDecision: boolean;
  decisionReason: string | null;
  suggestedName: string;
  suggestedType: TypeGuess;
  count: number;
  total: number;
  spellingCount: number;
};

export type EntityRow = {
  id: number;
  name: string;
  type: string;
  aliasCount: number;
  identifierCount: number;
  defaultCategoryId: number | null;
  count: number;
  total: number;
  lastDate: string | null;
};

export type BatchRow = {
  id: number;
  kind: string;
  actor: string;
  summary: Record<string, number>;
  entityIds: number[];
  createdAt: string;
  expiresAt: string;
  undoneAt: string | null;
  canUndo: boolean;
};

export type PayeeSettings = { advancedMode: boolean; identifierKinds: string[] };

export type PayeesResponse = {
  entities: EntityRow[];
  batches: BatchRow[];
  settings: PayeeSettings;
  groups: PayeeGroupRow[];
  totalGroups: number;
  clusters: PayeeClusterRow[];
  currency: string;
  truncated: string[];
  undecryptable: number;
};

const TYPE_LABEL: Record<string, string> = {
  retail: "Retail",
  service: "Service",
  bank: "Bank",
  government: "Government",
  person: "Person",
  sole_proprietor: "Sole proprietor",
  company: "Company",
  other: "Other",
};

export const PAYEE_TYPE_OPTIONS = Object.keys(TYPE_LABEL);

const BATCH_LABEL: Record<string, string> = {
  create: "Added to directory",
  update: "Edited",
  alias_add: "Alias added",
  alias_remove: "Alias removed",
  alias_from_rule: "Aliases from a rule",
  identifiers: "Requisites changed",
  merge: "Merged",
  split: "Split",
  apply: "Payees renamed",
  delete: "Removed from directory",
};

/** "Merged · 12 rows · by AI (MCP)" */
export function batchLabel(b: BatchRow): string {
  const who = b.actor === "mcp" ? "by AI (MCP)" : b.actor === "autopilot" ? "by autopilot" : b.actor === "import" ? "on import" : "by you";
  const rows = b.summary.rows ? ` · ${b.summary.rows} row${b.summary.rows === 1 ? "" : "s"}` : "";
  return `${BATCH_LABEL[b.kind] ?? b.kind}${rows} · ${who}`;
}

export function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t;
}

export function confidenceBadge(c: number) {
  const pct = Math.round(c * 100);
  const tone =
    c >= 0.85
      ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
      : c >= 0.7
        ? "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300"
        : "border-muted-foreground/30 text-muted-foreground";
  return (
    <Badge variant="outline" className={tone} title="How sure the match is">
      {pct}%
    </Badge>
  );
}

export const needsDecisionBadge = (title?: string | null) => (
  <Badge variant="outline" className="border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300" title={title ?? undefined}>
    Needs decision
  </Badge>
);

