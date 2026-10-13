/**
 * Shared types and small renderers for the Payee Studio pages.
 */
import { AlertTriangle } from "lucide-react";
import { actionChipClass } from "@/components/actions/action-button";
import { Badge } from "@/components/ui/badge";
import type { StudioT, StudioTextKey } from "@/lib/payees/i18n";

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
  /** P6.2: a transfer between own accounts (masked description of the account). */
  ownAccount?: string | null;
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
  /** P6.2: the Studio interface language. */
  language?: "uk" | "en";
};

export type PayeesResponse = {
  /** P6.2 (83): entries with a short / meaningless name to check. */
  suspicious?: import("./suspicious-panel").SuspiciousRow[];
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

const TYPE_LABEL: Record<string, StudioTextKey> = {
  retail: "types.retail",
  service: "types.service",
  bank: "types.bank",
  government: "types.government",
  person: "types.person",
  sole_proprietor: "types.sole_proprietor",
  company: "types.company",
  other: "types.other",
};

export const PAYEE_TYPE_OPTIONS = Object.keys(TYPE_LABEL);

const BATCH_LABEL: Record<string, StudioTextKey> = {
  create: "batch.create",
  update: "batch.update",
  alias_add: "batch.alias_add",
  alias_remove: "batch.alias_remove",
  alias_from_rule: "batch.alias_from_rule",
  identifiers: "batch.identifiers",
  merge: "batch.merge",
  split: "batch.split",
  apply: "batch.apply",
  delete: "batch.delete",
  approve: "batch.approve",
  import_hint: "batch.import_hint",
  autopilot: "batch.autopilot",
  dictionary_import: "batch.dictionary_import",
  move_remainder: "batch.move_remainder",
};

/** "Merged · 12 rows · by AI (MCP)" */
export function batchLabel(b: BatchRow, t: StudioT): string {
  const who = t(b.actor === "mcp" ? "batch.byMcp" : b.actor === "autopilot" ? "batch.byAutopilot" : b.actor === "import" ? "batch.onImport" : "batch.byYou");
  const rows = b.summary.rows ? ` · ${t("common.rows", { n: b.summary.rows })}` : "";
  const kind = BATCH_LABEL[b.kind];
  return `${kind ? t(kind) : b.kind}${rows} · ${who}`;
}

export function typeLabel(type: string, t: StudioT): string {
  const key = TYPE_LABEL[type];
  return key ? t(key) : type;
}

export function confidenceBadge(c: number, t: StudioT) {
  const pct = Math.round(c * 100);
  const tone =
    c >= 0.85
      ? actionChipClass("confirm")
      : c >= 0.7
        ? actionChipClass("caution")
        : actionChipClass("neutral");
  return (
    <Badge variant="outline" className={tone} title={t("common.confidenceTitle")}>
      {pct}%
    </Badge>
  );
}

/** P8: "needs your decision" is amber, with an icon and a label (never colour alone). */
export const needsDecisionBadge = (title: string | null | undefined, t: StudioT) => (
  <Badge variant="outline" className={`gap-1 ${actionChipClass("caution")}`} title={title ?? undefined}>
    <AlertTriangle aria-hidden="true" className="h-3 w-3" />
    {t("common.needsDecision")}
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
