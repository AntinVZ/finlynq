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

export type PayeesResponse = {
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

