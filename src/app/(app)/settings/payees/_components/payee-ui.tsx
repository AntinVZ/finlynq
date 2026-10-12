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
  /** P6: type words stripped from the core; `typeOnly` = no brand. */
  brand?: { core: string; removed: string[]; typeOnly: boolean; hint?: { group: string; name: string } | null };
  /** P6: the bank's own service row (matched pattern). */
  bankOperation?: string | null;
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
  /** P6.1: alias spellings (exact / contains), for the picker's search. */
  aliasNames?: string[];
  identifierCount: number;
  defaultCategoryId: number | null;
  website?: string | null;
  hasLogo?: boolean;
  /** P6: the entry's merchant type, and a suggestion when it has none. */
  merchantType?: { id: number; group: string; name: string } | null;
  /** P6.2: `strength` weak = found through an alias; `merchantTypeMixed` = name and aliases disagree. */
  merchantTypeHint?: { group: string; name: string; reason: string; strength?: "strong" | "weak"; field?: "name" | "alias"; matched?: string } | null;
  merchantTypeMixed?: string | null;
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

export type PayeeSettings = {
  advancedMode: boolean;
  identifierKinds: string[];
  importHint: boolean;
  autopilotEnabled: boolean;
  autopilotThreshold: number;
  typeWordsExtra?: string[];
  typeWordsOff?: string[];
  bankOpsExtra?: string[];
  bankOpsOff?: string[];
};

export type PayeesResponse = {
  draftCount?: number;
  lookalikeCount?: number;
  unrenamedRows?: number;
  entities: EntityRow[];
  merchantTypes?: Array<{ id: number | null; group: string; name: string; sort?: number; defaultCategoryId?: number | null }>;
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
  approve: "AI proposals accepted",
  import_hint: "Canonical names on import",
  autopilot: "Autopilot",
  dictionary_import: "Dictionary imported",
  move_remainder: "Payee renamed, rest kept as tag / note",
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


/** Logo (served by /api/payees/[id]/logo) or the name's initials. */
export function PayeeAvatar({ id, name, hasLogo, size = 24 }: { id: number; name: string; hasLogo?: boolean; size?: number }) {
  const initials =
    name
      .replace(/^(?:ТОВ|ФОП|ПП|LLC|FOP)\s+/i, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";
  if (hasLogo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`/api/payees/${id}/logo`} alt="" width={size} height={size} className="shrink-0 rounded object-contain bg-white" style={{ width: size, height: size }} />;
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {initials}
    </span>
  );
}

/** A merchant website link: opens in a new tab, no referrer, no follow. */
export function WebsiteLink({ url, className }: { url: string; className?: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={className ?? "text-sm hover:underline break-all"}>
      {url.replace(/^https:\/\//, "")}
    </a>
  );
}
