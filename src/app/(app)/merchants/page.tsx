"use client";

/**
 * /merchants — the Merchants section (P8 stage 1; was Settings → Payees).
 *
 * Every payee across transactions, recurring, staged imports, SimpleFIN
 * pending and the bank ledger (GET /api/payees). Spellings that are the same
 * name once letter case, apostrophes, Latin/Cyrillic transliteration and
 * card-terminal noise are ignored form one row. Private persons and sole
 * proprietors are flagged "needs your decision" and never merged by
 * themselves. Every change is previewed first and becomes a batch that
 * "Changes" can undo for 30 days.
 *
 * Tabs (the tab, its view, the search, chips, filters and the page live in
 * the URL, so they survive leaving and coming back; the scroll position is
 * kept per URL in sessionStorage):
 *  - Overview — the summary cards and insights.
 *  - Directory — entries with chips (all / merchants / people / channels)
 *    and filters (untyped, no requisites, needs a check), or every spelling.
 *  - Queue — what waits for a decision: similar spellings (clusters), other
 *    spellings of an entry (look-alikes), AI drafts, unrecognized payees,
 *    entries to check, bulk fill and people.
 *  - Channels & service — own accounts and cards, "whose card", requisites
 *    found in transactions, the bank's own service rows.
 *  - Dictionaries & packs — merchant types, type words, the dictionary file.
 *  - Changes — undoable batches.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR, { mutate as globalMutate } from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowDown, ArrowUp, Search, Settings2 } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/i18n/format-current";
import { containsNormalized } from "@/lib/text-normalize";
import {
  batchLabel,
  confidenceBadge,
  needsDecisionBadge,
  PayeeAvatar,
  type BatchRow,
  type PayeeClusterRow,
  type EntityRow,
  type PayeeGroupRow,
  type PayeesResponse,
} from "./_components/payee-ui";
import { MergeDialog } from "./_components/merge-dialog";
import { isColleaguesMerchantGroup, isPersonsMerchantGroup, PERSONS_MERCHANT_GROUP } from "@/lib/payees/payee-type";
import { groupMerchantTypes, localizedType, merchantTypeLabel, MerchantTypesEditor, PayeeTypeLabel, SetMerchantTypeDialog } from "./_components/merchant-type-ui";
import { OpDialog, describeRows, type OpPreview } from "./_components/op-dialog";
import { InsightsPanel } from "./_components/insights-panel";
import { AiDraftsPanel, AiRecipes } from "./_components/ai-drafts-panel";
import { AmountDuplicatesPanel, type AmountPair } from "./_components/amount-duplicates-panel";
import { MerchantsOverviewCards } from "./_components/overview-cards";
import { StudioSettingsDialog, WordListsSection } from "./_components/settings-dialog";
import { PacksCard } from "./_components/packs-card";
import { SuspiciousPanel } from "./_components/suspicious-panel";
import { OwnAccountsPanel } from "./_components/own-accounts-panel";
import { BulkPanel, PeoplePanel } from "./_components/bulk-panel";
import { useStudioT, type StudioT } from "./_components/i18n";
import { PayeeDrawer } from "./_components/payee-drawer";
import { ExplainDialog } from "./_components/explain-dialog";
import { LookalikesPanel } from "./_components/lookalikes-panel";
import { MinePanel } from "./_components/mine-panel";
import { WhosePanel } from "./_components/whose-panel";
import { MerchantSearchButton } from "@/components/merchants/merchant-search";
import { EmptyState, HelpHint, ListSkeleton, LoadError } from "@/components/merchants/state";
import { useUndoToast } from "@/components/merchants/undo-toast";
import { ActionButton } from "@/components/actions/action-button";

const PAGE_SIZES = [25, 50] as const;

export type Section = "overview" | "directory" | "queue" | "channels" | "dictionaries" | "changes";
const SECTIONS: Section[] = ["overview", "directory", "queue", "channels", "dictionaries", "changes"];
type QueueView = "clusters" | "lookalikes" | "drafts" | "unrecognized" | "suspicious" | "amounts" | "bulk" | "people";
const QUEUE_VIEWS: QueueView[] = ["clusters", "lookalikes", "drafts", "unrecognized", "suspicious", "amounts", "bulk", "people"];
type DirectoryView = "entries" | "spellings";
type Chip = "all" | "merchants" | "people" | "colleagues" | "channels";
const CHIPS: Chip[] = ["all", "merchants", "people", "colleagues", "channels"];
type Filter = "untyped" | "noRequisites" | "needsCheck";
const FILTERS: Filter[] = ["untyped", "noRequisites", "needsCheck"];
const CHIP_KEY = { all: "merchants.chip.all", merchants: "merchants.chip.merchants", people: "merchants.chip.people", colleagues: "merchants.chip.colleagues", channels: "merchants.chip.channels" } as const;
const FILTER_KEY = { untyped: "merchants.filter.untyped", noRequisites: "merchants.filter.noRequisites", needsCheck: "merchants.filter.needsCheck" } as const;
type SortKey = "count" | "name" | "total" | "lastDate";

/** Merchant-type codes that make an entry a channel (the bank's own operations), not a merchant. */
const CHANNEL_TYPE_CODES = new Set(["bank_operations", "bank_fees"]);

type Action =
  | {
      kind: "merge";
      title: string;
      payees: string[];
      entityIds: number[];
      suggestedName: string;
      suggestedType: string;
      warning: string | null;
      typeHint: { group: string; name: string; reason: string } | null;
      clusterKeys: string[];
    }
  | { kind: "undo"; batch: BatchRow }
  /** P8 stage 3: one-click canonical — a preview of one prepared change, then confirm. */
  | { kind: "quick"; title: string; body: Record<string, unknown>; note: string }
  | { kind: "applyAll" }
  | { kind: "setType" }
  | { kind: "types" };

/**
 * P6.1: a merchant-type suggestion for the merge dialog (offered, never set by
 * itself): an entry's own type, a type word in a spelling, a bank operation,
 * a private person → «Особи і ФОП», then an entry's suggestion. Only types
 * present in the user's dictionary are offered.
 */
function mergeTypeHint(
  groups: readonly PayeeGroupRow[],
  sourceEntities: readonly EntityRow[],
  types: ReadonlyArray<{ group: string; name: string }>,
  t: StudioT,
): { group: string; name: string; reason: string } | null {
  const known = (t: { group: string; name: string } | null | undefined) =>
    t ? (types.find((x) => x.group === t.group && x.name === t.name) ?? types.find((x) => x.name === t.name) ?? null) : null;
  const pick = (t: { group: string; name: string } | null | undefined, reason: string) => {
    const k = known(t);
    return k ? { group: k.group, name: k.name, reason } : null;
  };
  for (const e of sourceEntities) {
    const h = pick(e.merchantType, t("page.hint.entryType", { name: e.name }));
    if (h) return h;
  }
  for (const g of groups) {
    const h = g.brand?.hint ? pick(g.brand.hint, t("page.hint.typeWord", { word: g.brand.removed[0] ?? "" })) : null;
    if (h) return h;
  }
  if (groups.some((g) => g.bankOperation)) {
    const h = pick({ group: "Банківські операції", name: "Банківські операції" }, t("page.hint.bankOperation"));
    if (h) return h;
  }
  if (groups.length && groups.every((g) => g.type.isPerson)) {
    const h = pick({ group: PERSONS_MERCHANT_GROUP, name: PERSONS_MERCHANT_GROUP }, t("page.hint.person"));
    if (h) return h;
  }
  for (const e of sourceEntities) {
    // P6.2 (B29): an alias-only (weak) or mixed hint is never offered.
    if (e.merchantTypeHint?.strength === "weak" || e.merchantTypeMixed) continue;
    const h = pick(e.merchantTypeHint, e.merchantTypeHint?.reason ?? "");
    if (h) return h;
  }
  return null;
}

/** Which chip an entry belongs to: a colleague, a person (or ФОП), a channel, or a merchant. */
export function entryChip(e: Pick<EntityRow, "type" | "merchantType">): Exclude<Chip, "all"> {
  if (e.merchantType && CHANNEL_TYPE_CODES.has(e.merchantType.code ?? "")) return "channels";
  if (e.merchantType && e.merchantType.group === "Банківські операції") return "channels";
  // P8 stage 11: colleagues apart from other people and ФОП.
  if (isColleaguesMerchantGroup(e.merchantType?.group, e.merchantType?.code)) return "colleagues";
  if (e.type === "person" || e.type === "sole_proprietor" || isPersonsMerchantGroup(e.merchantType?.group, e.merchantType?.code)) return "people";
  return "merchants";
}

/** Tab, view, search, chips, filters and page live in the URL (they survive leaving and coming back). */
function useUrlState() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? "/merchants";
  const get = useCallback((k: string) => params?.get(k) ?? "", [params]);
  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params?.toString() ?? "");
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, router, pathname],
  );
  return { get, set, key: params?.toString() ?? "" };
}

/** Keep the scroll position per URL for the session; restore it once the content is there. */
function useScrollMemory(key: string, ready: boolean) {
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || restored.current === key) return;
    restored.current = key;
    try {
      const y = Number(window.sessionStorage.getItem(`finlynq.merchants.scroll:${key}`) ?? "");
      if (y > 0) window.scrollTo({ top: y });
    } catch {
      /* storage blocked */
    }
  }, [key, ready]);
  useEffect(() => {
    let h: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(h);
      h = setTimeout(() => {
        try {
          window.sessionStorage.setItem(`finlynq.merchants.scroll:${key}`, String(Math.round(window.scrollY)));
        } catch {
          /* storage blocked */
        }
      }, 150);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(h);
      window.removeEventListener("scroll", onScroll);
    };
  }, [key]);
}

export default function MerchantsPage() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <MerchantsSection />
    </Suspense>
  );
}

function MerchantsSection() {
  const t = useStudioT();
  const url = useUrlState();
  const [drawer, setDrawer] = useState<PayeeGroupRow | null>(null);
  const [explain, setExplain] = useState<{ a: string; b: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "count", dir: "desc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action | null>(null);
  const [pickedEntities, setPickedEntities] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState("");

  const { data, error: loadErr, mutate, isLoading } = useSWR<PayeesResponse>("/api/payees", jsonFetcher, { revalidateOnFocus: false });

  // ─── URL state ────────────────────────────────────────────────────────────
  const sectionParam = url.get("tab") as Section;
  const section: Section = SECTIONS.includes(sectionParam) ? sectionParam : "overview";
  const viewParam = url.get("view");
  const queueView: QueueView = QUEUE_VIEWS.includes(viewParam as QueueView)
    ? (viewParam as QueueView)
    : data && data.clusters.length === 0
      ? "unrecognized"
      : "clusters";
  const directoryView: DirectoryView = viewParam === "spellings" ? "spellings" : "entries";
  const chip: Chip = CHIPS.includes(url.get("chip") as Chip) ? (url.get("chip") as Chip) : "all";
  const filters = useMemo(() => new Set(url.get("f").split(",").filter((f): f is Filter => FILTERS.includes(f as Filter))), [url]);
  const typeFilter = url.get("type");
  const pageSize = PAGE_SIZES.includes(Number(url.get("size")) as 25 | 50) ? Number(url.get("size")) : 25;
  const page = Math.max(0, Number(url.get("p")) || 0);
  const setPage = (fn: (p: number) => number) => url.set({ p: String(fn(page) || "") });
  const go = (patch: Record<string, string | null>) => url.set({ p: null, ...patch });

  // The search box types into local state; the URL follows a moment later.
  const urlQuery = url.get("q");
  const [query, setQuery] = useState(urlQuery);
  const [seenUrlQuery, setSeenUrlQuery] = useState(urlQuery);
  if (urlQuery !== seenUrlQuery) {
    setSeenUrlQuery(urlQuery);
    setQuery(urlQuery);
  }
  const setUrl = url.set;
  useEffect(() => {
    if (query === urlQuery) return;
    const h = setTimeout(() => setUrl({ q: query || null, p: null }), 250);
    return () => clearTimeout(h);
  }, [query, urlQuery, setUrl]);

  useScrollMemory(url.key, Boolean(data));

  const currency = data?.currency ?? "USD";
  const entities = useMemo(() => data?.entities ?? [], [data]);
  const entityOptions = useMemo(
    () => entities.map((e) => ({ id: e.id, name: e.name, type: e.type, merchantType: e.merchantType ?? null, count: e.count, aliasCount: e.aliasCount, aliases: e.aliasNames ?? [] })),
    [entities],
  );

  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const groupsByKey = useMemo(() => new Map((data?.groups ?? []).map((g) => [g.key, g])), [data]);
  const suspiciousIds = useMemo(() => new Set((data?.suspicious ?? []).map((s) => s.id)), [data]);

  const listingSpellings = (section === "queue" && queueView === "unrecognized") || (section === "directory" && directoryView === "spellings");
  const rows = useMemo(() => {
    let list = (data?.groups ?? []).filter((g) => g.key);
    if (section === "queue") list = list.filter((g) => g.entityId == null && !g.bankOperation && !g.ownAccount && !g.channel);
    if (query.trim()) list = list.filter((g) => g.spellings.some((s) => containsNormalized(s.spelling, query)) || (g.entityName != null && containsNormalized(g.entityName, query)));
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * dir;
      if (sort.key === "total") return (Math.abs(a.total) - Math.abs(b.total)) * dir || a.name.localeCompare(b.name);
      if (sort.key === "lastDate") return (a.lastDate ?? "").localeCompare(b.lastDate ?? "") * dir;
      return (a.count - b.count) * dir || (a.rows - b.rows) * dir || a.name.localeCompare(b.name);
    });
  }, [data, section, query, sort]);

  const clusters = useMemo(() => {
    const list = data?.clusters ?? [];
    if (!query.trim()) return list;
    return list.filter((c) => c.keys.some((k) => groupsByKey.get(k)?.spellings.some((s) => containsNormalized(s.spelling, query))));
  }, [data, query, groupsByKey]);

  const chipCounts = useMemo(() => {
    const out: Record<Chip, number> = { all: entities.length, merchants: 0, people: 0, colleagues: 0, channels: 0 };
    for (const e of entities) out[entryChip(e)]++;
    return out;
  }, [entities]);

  const entityRows = useMemo(() => {
    let list = query.trim() ? entities.filter((e) => containsNormalized(e.name, query) || (e.aliasNames ?? []).some((a) => containsNormalized(a, query))) : entities;
    if (chip !== "all") list = list.filter((e) => entryChip(e) === chip);
    if (filters.has("untyped")) list = list.filter((e) => !e.merchantType);
    if (filters.has("noRequisites")) list = list.filter((e) => !e.identifierCount);
    if (filters.has("needsCheck")) list = list.filter((e) => suspiciousIds.has(e.id) || Boolean(e.merchantTypeMixed));
    if (typeFilter === "none") list = list.filter((e) => !e.merchantType);
    else if (typeFilter) list = list.filter((e) => e.merchantType?.group === typeFilter);
    return list;
  }, [entities, query, typeFilter, chip, filters, suspiciousIds]);
  const merchantTypes = useMemo(() => data?.merchantTypes ?? [], [data]);

  const unrecognizedCount = useMemo(() => (data?.groups ?? []).filter((g) => g.key && g.entityId == null && !g.bankOperation && !g.ownAccount && !g.channel).length, [data]);
  const payeeCount = useMemo(() => (data?.groups ?? []).filter((g) => g.key).length, [data]);
  const serviceGroups = useMemo(() => (data?.groups ?? []).filter((g) => g.key && (g.bankOperation || g.ownAccount || g.channel)), [data]);
  const pageRows = useMemo(() => rows.slice(page * pageSize, (page + 1) * pageSize), [rows, page, pageSize]);
  const pageEntities = useMemo(() => entityRows.slice(page * pageSize, (page + 1) * pageSize), [entityRows, page, pageSize]);
  const blank = data?.groups.find((g) => !g.key);
  const selectedGroups = useMemo(() => (data?.groups ?? []).filter((g) => selected.has(g.key)), [data, selected]);
  const queueTotal = data ? data.clusters.length + (data.lookalikeCount ?? 0) + (data.draftCount ?? 0) + (data.suspicious?.length ?? 0) : 0;

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }
  const sortIcon = (key: SortKey) =>
    sort.key === key ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null;
  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleFilter(f: Filter) {
    const next = new Set(filters);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    go({ f: [...next].join(",") || null });
  }

  /** Merge dialog for a set of groups (a cluster, a selection, or one row). */
  function mergeGroups(title: string, groups: PayeeGroupRow[], cluster?: PayeeClusterRow) {
    const lead = [...groups].sort((a, b) => b.count - a.count)[0];
    const people = groups.filter((g) => g.type.isPerson);
    const entityIds = [...new Set(groups.map((g) => g.entityId).filter((id): id is number => id != null))];
    setAction({
      kind: "merge",
      title,
      payees: groups.filter((g) => g.entityId == null).flatMap((g) => g.spellings.map((s) => s.spelling)),
      entityIds,
      suggestedName: cluster?.suggestedName ?? lead?.entityName ?? lead?.suggestedName ?? "",
      suggestedType: cluster?.suggestedType.type ?? lead?.type.type ?? "other",
      warning:
        people.length && people.length < groups.length
          ? t("page.mixWarning")
          : cluster?.decisionReason ?? null,
      typeHint: mergeTypeHint(groups, entityIds.map((id) => entities.find((e) => e.id === id)).filter((e): e is EntityRow => e != null), merchantTypes, t),
      clusterKeys: groups.map((g) => g.key),
    });
  }

  const refresh = useCallback(() => Promise.all([mutate(), globalMutate("/api/payees/queue")]), [mutate]);
  const undoToast = useUndoToast(async (n) => {
    setStatus(t("common.undone", { n }));
    await refresh();
  });

  async function done(r: OpPreview, message?: string) {
    setAction(null);
    setSelected(new Set());
    const text = message ?? (r.undo ? t("common.undone", { n: r.undo.restoredRows }) : t("common.saved", { rows: describeRows(r, t) }));
    // P8 stage 3: a confirmed change can be undone from the toast for 10 s (and from Changes for 30 days).
    if (r.batchId && !r.undo && r.op !== "undo") {
      setStatus("");
      undoToast.show(r.batchId, text);
    } else setStatus(text);
    await refresh();
  }

  /**
   * P8 stage 3: one click to make a cluster one entry under its suggested
   * canonical name (or into the one entry it already resolves to). Still a
   * preview first; people / ФОП never get it (the full dialog only).
   */
  function quickCanonical(c: PayeeClusterRow) {
    const groups = c.keys.map((k) => groupsByKey.get(k)).filter((g): g is PayeeGroupRow => !!g);
    const entityIds = [...new Set(groups.map((g) => g.entityId).filter((id): id is number => id != null))];
    const payees = groups.filter((g) => g.entityId == null).flatMap((g) => g.spellings.map((s) => s.spelling));
    const target = entityIds.length === 1 ? entityById.get(entityIds[0]) : undefined;
    const name = target?.name ?? c.suggestedName;
    setAction({
      kind: "quick",
      title: t("quick.title", { name }),
      note: target ? t("quick.intoEntry", { name }) : t("quick.newEntry", { name }),
      body: target
        ? { op: "merge", into: { entityId: target.id }, entityIds: [], payees }
        : { op: "merge", into: { name, type: c.suggestedType.type }, entityIds, payees },
    });
  }

  async function saveSettings(patch: Record<string, unknown>) {
    await fetch("/api/payees/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
    await Promise.all([mutate(), globalMutate("/api/payees/settings")]);
  }

  const spellingsBadge = (g: PayeeGroupRow) =>
    g.spellings.length > 1 ? (
      <Badge
        variant="outline"
        className="ms-2 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300"
        title={g.spellings.map((s) => `"${s.spelling}" × ${s.count}`).join(", ")}
      >
        {t("page.spellingsBadge", { n: g.spellings.length })}
      </Badge>
    ) : null;
  const payeeLink = (g: PayeeGroupRow) =>
    g.entityId != null ? (
      <Link href={`/merchants/${g.entityId}`} className="font-medium hover:underline break-all">
        {g.entityName ?? g.name}
      </Link>
    ) : (
      <button type="button" className="font-medium hover:underline break-all text-start" onClick={() => setDrawer(g)}>
        {g.name}
      </button>
    );
  const typeCell = (g: PayeeGroupRow) => (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={g.type.confidence < 0.5 ? "text-muted-foreground" : undefined} title={g.type.reason}>
        <PayeeTypeLabel merchantType={g.entityId != null ? entityById.get(g.entityId)?.merchantType : null} type={g.type.type} />
      </span>
      {g.type.isPerson && g.entityId == null && needsDecisionBadge(g.type.reason, t)}
      {g.bankOperation && (
        <Badge variant="outline" className="text-[10px]" title={t("page.bankOpTitle", { op: g.bankOperation })}>
          {t("page.bankOp")}
        </Badge>
      )}
      {g.channel && (
        <Badge variant="outline" className="text-[10px]" title={t("page.channelTitle", { channel: g.channel })}>
          {t("page.channel")}
        </Badge>
      )}
      {g.ownAccount && (
        <Badge variant="outline" className="text-[10px]" title={t("own.badgeTitle", { account: g.ownAccount })}>
          {t("own.badge")}
        </Badge>
      )}
      {g.brand?.typeOnly && !g.bankOperation && (
        <Badge variant="outline" className="text-[10px]" title={t("page.noBrandTitle", { words: g.brand.removed.join(", ") })}>
          {t("page.noBrand")}
        </Badge>
      )}
    </span>
  );
  const rowAction = (g: PayeeGroupRow) =>
    g.entityId == null ? (
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => mergeGroups(t("page.addTitle", { name: g.name }), [g])}>
        {t("common.addToDirectory")}
      </Button>
    ) : null;
  const checkbox = (g: PayeeGroupRow) => (
    <input type="checkbox" aria-label={t("page.select", { name: g.name })} checked={selected.has(g.key)} onChange={() => toggle(g.key)} />
  );

  const pager = (total: number) =>
    total > PAGE_SIZES[0] ? (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label={t("page.pages")}>
        <span className="tabular-nums">
          {t("page.range", { from: page * pageSize + 1, to: Math.min(total, (page + 1) * pageSize), total })}
        </span>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          {t("page.previous")}
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((p) => p + 1)}>
          {t("page.next")}
        </Button>
        <label className="ms-auto inline-flex items-center gap-1">
          {t("page.perPage")}
          <select aria-label={t("page.rowsPerPage")} className="h-7 rounded-md border bg-background px-1" value={pageSize} onChange={(e) => go({ size: e.target.value === "25" ? null : e.target.value })}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
    ) : null;

  const count = (n: number | undefined) => (data ? ` (${n ?? 0})` : "");
  const sectionTabs: Array<{ id: Section; label: string; badge?: number }> = [
    { id: "overview", label: t("merchants.tab.overview") },
    { id: "directory", label: `${t("merchants.tab.directory")}${count(entities.length)}` },
    { id: "queue", label: t("merchants.tab.queue"), badge: queueTotal },
    { id: "channels", label: t("merchants.tab.channels") },
    { id: "dictionaries", label: t("merchants.tab.dictionaries") },
    { id: "changes", label: t("page.tab.changes") },
  ];
  const queueTabs: Array<{ id: QueueView; label: string; help?: string }> = [
    { id: "clusters", label: `${t("page.tab.clusters")}${count(data?.clusters.length)}`, help: t("merchants.help.clusters") },
    { id: "lookalikes", label: `${t("page.tab.lookalikes")}${count(data?.lookalikeCount)}`, help: t("merchants.help.lookalikes") },
    { id: "drafts", label: `${t("merchants.queue.drafts")}${count(data?.draftCount)}` },
    { id: "unrecognized", label: `${t("page.tab.unrecognized")}${count(unrecognizedCount)}`, help: t("merchants.help.unrecognized") },
    { id: "suspicious", label: `${t("suspicious.tab")}${count(data?.suspicious?.length)}` },
    { id: "amounts", label: t("amountDup.tab") },
    { id: "bulk", label: t("bulk.tab") },
    { id: "people", label: t("people.tab") },
  ];

  const searchBox = (
    <div className="relative flex-1 min-w-48">
      <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input className="ps-8" placeholder={t("page.search")} aria-label={t("page.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
    </div>
  );
  const subTabs = <T extends string>(label: string, items: Array<{ id: T; label: string; help?: string }>, current: T, onPick: (id: T) => void) => (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-md border p-0.5" role="tablist" aria-label={label}>
      {items.map((x) => (
        <span key={x.id} className="inline-flex items-center">
          <Button role="tab" aria-selected={current === x.id} variant={current === x.id ? "secondary" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => onPick(x.id)}>
            {x.label}
          </Button>
          {x.help && current === x.id && <HelpHint text={x.help} className="me-1" />}
        </span>
      ))}
    </div>
  );

  const spellingsTable = (emptyReason: string) =>
    rows.length === 0 ? (
      <EmptyState reason={emptyReason} />
    ) : (
      <>
        {/* Phones: one card per payee */}
        <ul className="space-y-2 sm:hidden">
          {pageRows.map((g) => (
            <li key={g.key} className="rounded-lg border p-3 text-sm">
              <div className="flex items-start gap-2">
                <span className="mt-1">{checkbox(g)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center">
                    {payeeLink(g)}
                    {spellingsBadge(g)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{typeCell(g)}</p>
                  <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                    {t("common.tx", { n: g.count })} · {formatCurrency(g.total, currency)} · {formatDate(g.firstDate)} → {formatDate(g.lastDate)}
                  </p>
                  {g.categories.length > 0 && <p className="text-xs text-muted-foreground truncate">{g.categories.map((c) => c.name).join(", ")}</p>}
                </div>
              </div>
              <div className="flex justify-end">{rowAction(g)}</div>
            </li>
          ))}
        </ul>
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-start text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="w-8 py-2" />
                <th className="py-2 pe-2">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("name")}>
                    {t("analytics.payee")} {sortIcon("name")}
                  </button>
                </th>
                <th className="py-2 pe-2">{t("common.type")}</th>
                <th className="py-2 pe-2 text-end">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("count")}>
                    {t("common.transactions")} {sortIcon("count")}
                  </button>
                </th>
                <th className="py-2 pe-2 text-end">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("total")}>
                    {t("page.totalCol", { currency })} {sortIcon("total")}
                  </button>
                </th>
                <th className="py-2 pe-2">{t("common.first")}</th>
                <th className="py-2 pe-2">
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("lastDate")}>
                    {t("common.lastDate")} {sortIcon("lastDate")}
                  </button>
                </th>
                <th className="py-2 pe-2">{t("common.accounts")}</th>
                <th className="py-2 pe-2">{t("page.categories")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((g) => (
                <tr key={g.key} className="border-b last:border-0 align-top">
                  <td className="py-2">{checkbox(g)}</td>
                  <td className="py-2 pe-2">
                    <div className="flex flex-wrap items-center">
                      {payeeLink(g)}
                      {spellingsBadge(g)}
                    </div>
                    {g.entityName && g.entityName !== g.name && <p className="text-xs text-muted-foreground">{t("page.asSpelling", { name: g.name })}</p>}
                  </td>
                  <td className="py-2 pe-2 text-xs">{typeCell(g)}</td>
                  <td className="py-2 pe-2 text-end tabular-nums">
                    {g.count}
                    {g.rows > g.count && (
                      <span className="block text-xs text-muted-foreground" title={t("page.otherRowsTitle")}>
                        {t("common.otherRows", { n: g.rows - g.count })}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pe-2 text-end tabular-nums">{formatCurrency(g.total, currency)}</td>
                  <td className="py-2 pe-2 text-xs tabular-nums">{formatDate(g.firstDate)}</td>
                  <td className="py-2 pe-2 text-xs tabular-nums">{formatDate(g.lastDate)}</td>
                  <td className="py-2 pe-2 text-xs text-muted-foreground max-w-40 truncate">{g.accounts.map((a) => a.name).join(", ") || "—"}</td>
                  <td className="py-2 pe-2 text-xs text-muted-foreground max-w-48 truncate">{g.categories.map((c) => c.name).join(", ") || "—"}</td>
                  <td className="py-2 text-end whitespace-nowrap">{rowAction(g)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pager(rows.length)}
        {data && data.totalGroups > data.groups.length && <p className="text-xs text-muted-foreground">{t("page.showingMostUsed", { n: data.groups.length, total: data.totalGroups })}</p>}
      </>
    );

  const spellingTools = (
    <>
      <Button variant="outline" size="sm" disabled={selectedGroups.length < 2} onClick={() => mergeGroups(t("page.mergeTitle", { n: selectedGroups.length }), selectedGroups)}>
        {t("page.mergeSelected")}
        {selectedGroups.length >= 2 ? ` (${selectedGroups.length})` : ""}
      </Button>
      <Button variant="ghost" size="sm" title={t("page.explainTitle")} onClick={() => setExplain({ a: selectedGroups[0]?.name ?? "", b: selectedGroups[1]?.name ?? "" })}>
        {t("common.explain")}
      </Button>
    </>
  );

  const clusterList =
    clusters.length === 0 ? (
      <EmptyState reason={query ? t("page.noClustersMatch") : t("page.noClusters")} />
    ) : (
      <ul className="space-y-2">
        {clusters.map((c) => (
          <li key={c.id} className="rounded-lg border p-3 text-sm space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{c.suggestedName || "—"}</span>
              {confidenceBadge(c.confidence, t)}
              <PayeeTypeLabel
                className="text-xs text-muted-foreground"
                merchantType={c.keys.map((k) => groupsByKey.get(k)?.entityId).map((id) => (id != null ? entityById.get(id)?.merchantType : null)).find((x) => x) ?? null}
                type={c.suggestedType.type}
              />
              {c.needsDecision && needsDecisionBadge(c.decisionReason, t)}
              <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                {t("common.tx", { n: c.count })} · {formatCurrency(c.total, currency)}
              </span>
            </div>
            <ul className="text-xs text-muted-foreground list-disc ps-5">
              {c.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
              {c.decisionReason && <li className="text-rose-700 dark:text-rose-300">{c.decisionReason}</li>}
            </ul>
            <div className="flex flex-wrap gap-1.5">
              {c.keys.flatMap((k) =>
                (groupsByKey.get(k)?.spellings ?? []).map((s) => (
                  <Badge key={`${k}|${s.spelling}`} variant="secondary" className="font-normal">
                    {s.spelling} <span className="ms-1 text-muted-foreground">× {s.count}</span>
                  </Badge>
                )),
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {c.needsDecision ? (
                <span className="me-auto text-xs text-muted-foreground">{t("quick.peopleNote")}</span>
              ) : (
                c.suggestedName && (
                  <ActionButton intent="confirm" size="sm" className="h-7 text-xs" onClick={() => quickCanonical(c)}>
                    {t("quick.button", { name: c.suggestedName })}
                  </ActionButton>
                )
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => mergeGroups(t("page.mergeOne"), c.keys.map((k) => groupsByKey.get(k)).filter((g): g is PayeeGroupRow => !!g), c)}
              >
                {t("page.mergeEllipsis")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    );

  const entryList = (
    <>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("merchants.chips")}>
        {CHIPS.map((c) => (
          <Button key={c} size="sm" variant={chip === c ? "secondary" : "outline"} className="h-7 rounded-full text-xs" aria-pressed={chip === c} onClick={() => go({ chip: c === "all" ? null : c })}>
            {t(CHIP_KEY[c])}
            {data ? ` · ${chipCounts[c]}` : ""}
          </Button>
        ))}
        <span className="mx-1 h-5 border-s" aria-hidden="true" />
        {FILTERS.map((f) => (
          <label key={f} className="inline-flex items-center gap-1 text-xs">
            <input type="checkbox" checked={filters.has(f)} onChange={() => toggleFilter(f)} />
            {t(FILTER_KEY[f])}
          </label>
        ))}
        <HelpHint text={t("merchants.help.needsCheck")} />
      </div>
      {entityRows.length === 0 ? (
        <EmptyState
          reason={
            query
              ? t("page.noEntriesMatch")
              : entities.length === 0
                ? t("page.directoryEmpty")
                : t("merchants.emptyFiltered")
          }
          action={
            entities.length === 0 ? (
              <Button size="sm" variant="outline" onClick={() => go({ tab: "queue", view: null, chip: null, f: null })}>
                {t("merchants.openQueue")}
              </Button>
            ) : chip !== "all" || filters.size || typeFilter ? (
              <Button size="sm" variant="outline" onClick={() => go({ chip: null, f: null, type: null })}>
                {t("merchants.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="divide-y rounded-lg border">
            {pageEntities.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                <input
                  type="checkbox"
                  aria-label={t("page.select", { name: e.name })}
                  checked={pickedEntities.has(e.id)}
                  onChange={() =>
                    setPickedEntities((prev) => {
                      const next = new Set(prev);
                      if (next.has(e.id)) next.delete(e.id);
                      else next.add(e.id);
                      return next;
                    })
                  }
                />
                <PayeeAvatar id={e.id} name={e.name} hasLogo={e.hasLogo} />
                <Link href={`/merchants/${e.id}`} className="font-medium hover:underline break-all">
                  {e.name}
                </Link>
                {!e.merchantType && <PayeeTypeLabel className="text-xs text-muted-foreground" type={e.type} />}
                <span className="text-xs" title={t("types.merchantType")}>
                  {t("page.typeLabel")}{" "}
                  {e.merchantType ? (
                    merchantTypeLabel(e.merchantType, t)
                  ) : e.merchantTypeMixed ? (
                    <span className="text-amber-600 dark:text-amber-400" title={t("page.mixedTitle", { reason: e.merchantTypeMixed })}>
                      — ({t("page.mixed")})
                    </span>
                  ) : e.merchantTypeHint ? (
                    <span className={`text-muted-foreground ${e.merchantTypeHint.strength === "weak" ? "opacity-70 italic" : ""}`} title={t("page.hintTitle", { reason: e.merchantTypeHint.reason })}>
                      — ({e.merchantTypeHint.strength === "weak" ? t("page.weakHintLower") : t("page.hintLower")}: {merchantTypeLabel(e.merchantTypeHint, t)}
                      {e.merchantTypeHint.strength === "weak" ? `, ${e.merchantTypeHint.reason}` : ""})
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
                {suspiciousIds.has(e.id) && (
                  <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300">
                    {t("suspicious.tab")}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {t("common.aliases", { n: e.aliasCount })}
                  {data?.settings.advancedMode && e.identifierCount ? ` · ${t("page.requisitesCount", { n: e.identifierCount })}` : ""}
                </span>
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                  {t("common.tx", { n: e.count })} · {formatCurrency(e.total, currency)}
                  {e.lastDate ? ` · ${t("common.last", { date: formatDate(e.lastDate) })}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {pager(entityRows.length)}
        </>
      )}
    </>
  );

  const summary = (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label={t("page.summary")}>
      {[
        { label: t("page.title"), value: data ? String(payeeCount) : "…", onClick: () => go({ tab: "directory", view: "spellings" }) },
        { label: t("page.sum.notInDirectory"), value: data ? String(unrecognizedCount) : "…", onClick: () => go({ tab: "queue", view: "unrecognized" }) },
        { label: t("page.sum.mergeCandidates"), value: data ? String(data.clusters.length) : "…", onClick: () => go({ tab: "queue", view: "clusters" }) },
        { label: t("page.sum.newLookalikes"), value: data ? String(data.lookalikeCount ?? 0) : "…", onClick: () => go({ tab: "queue", view: "lookalikes" }) },
        { label: t("page.sum.autoReplace"), value: data ? (data.settings.importHint ? t("page.on") : t("page.off")) : "…", onClick: () => setSettingsOpen(true) },
      ].map((c) => (
        <button key={c.label} type="button" onClick={c.onClick} className="rounded-lg border p-2 text-start hover:bg-accent/50">
          <span className="block text-xs text-muted-foreground">{c.label}</span>
          <span className="block text-lg font-semibold tabular-nums">{c.value}</span>
        </button>
      ))}
      <Link href="/merchants/review" className="rounded-lg border p-2 hover:bg-accent/50">
        <span className="block text-xs text-muted-foreground">{t("page.aiAssistant")}</span>
        <span className="flex items-center gap-1 text-sm font-medium">
          {t("page.reviewWithAi")}
          {data?.draftCount ? <Badge variant="secondary">{t("page.waiting", { n: data.draftCount })}</Badge> : null}
        </span>
      </Link>
    </div>
  );

  const notices = (
    <>
      {status && <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">{status}</p>}
      {data && data.truncated.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">{t("page.truncated", { list: data.truncated.join(", ") })}</p>}
      {data && data.undecryptable > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">{t("page.undecryptable", { n: data.undecryptable })}</p>}
      {blank && blank.count > 0 && listingSpellings && <p className="text-xs text-muted-foreground">{t("page.blank", { n: blank.count })}</p>}
    </>
  );

  let body: React.ReactNode;
  if (loadErr && !data) body = <LoadError message={t("page.loadFailed")} onRetry={() => void mutate()} />;
  else if (!data && (isLoading || !loadErr)) body = <ListSkeleton label={t("page.loading")} />;
  else if (section === "overview")
    body = (
      <div className="space-y-6">
        {summary}
        <MerchantsOverviewCards
          start={{ hasDirectory: entities.length > 0, typedAll: entities.length > 0 && entities.every((e) => e.merchantType), hintOn: !!data?.settings.importHint }}
          onOpen={(to) =>
            to === "settings"
              ? setSettingsOpen(true)
              : to === "queue"
                ? go({ tab: "queue", view: "unrecognized" })
                : to === "suspicious"
                  ? go({ tab: "queue", view: "suspicious" })
                  : to === "people"
                    ? go({ tab: "queue", view: "people" })
                  : go({ tab: "directory", view: "entries", f: "untyped" })
          }
        />
        <AiRecipes />
        <InsightsPanel />
      </div>
    );
  else if (section === "directory")
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {subTabs(
            t("merchants.directoryViews"),
            [
              { id: "entries" as DirectoryView, label: `${t("merchants.view.entries")}${count(entities.length)}` },
              { id: "spellings" as DirectoryView, label: `${t("merchants.view.spellings")}${count(payeeCount)}`, help: t("merchants.help.spellings") },
            ],
            directoryView,
            (v) => go({ view: v === "entries" ? null : v }),
          )}
          {searchBox}
          {directoryView === "spellings" ? (
            spellingTools
          ) : (
            <>
              {entities.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => setAction({ kind: "applyAll" })}>
                    {t("page.applyDirectory")}
                  </Button>
                  <HelpHint text={t("merchants.help.apply")} />
                </span>
              )}
              <select aria-label={t("page.typeFilter")} className="h-8 rounded-md border bg-background px-2 text-xs" value={typeFilter} onChange={(ev) => go({ type: ev.target.value || null })}>
                <option value="">{t("page.allTypes")}</option>
                <option value="none">{t("page.untyped")}</option>
                {groupMerchantTypes(merchantTypes).map((g) => (
                  <option key={g.group} value={g.group}>
                    {g.items[0] ? localizedType(g.items[0], t).group : g.group}
                  </option>
                ))}
              </select>
              <Button variant="outline" size="sm" disabled={!entities.length} onClick={() => setAction({ kind: "setType" })}>
                {t("page.setType")}
                {pickedEntities.size ? ` (${pickedEntities.size})` : ""}…
              </Button>
            </>
          )}
        </div>
        {notices}
        {directoryView === "spellings" ? spellingsTable(query ? t("page.noPayeesMatch") : t("page.noPayees")) : entryList}
      </div>
    );
  else if (section === "queue")
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {subTabs(t("page.views"), queueTabs, queueView, (v) => go({ view: v }))}
          {(queueView === "clusters" || queueView === "unrecognized") && searchBox}
          {queueView === "unrecognized" && spellingTools}
          {queueView === "clusters" && (
            <Button variant="ghost" size="sm" title={t("page.explainTitle")} onClick={() => setExplain({ a: "", b: "" })}>
              {t("common.explain")}
            </Button>
          )}
        </div>
        {notices}
        {queueView === "clusters" ? (
          clusterList
        ) : queueView === "lookalikes" ? (
          <LookalikesPanel onChanged={() => void Promise.all([mutate(), globalMutate("/api/payees/queue")])} />
        ) : queueView === "drafts" ? (
          <AiDraftsPanel onChanged={() => void Promise.all([mutate(), globalMutate("/api/payees/queue")])} />
        ) : queueView === "suspicious" ? (
          <SuspiciousPanel rows={data?.suspicious ?? []} entities={entityOptions} onDone={(r) => done(r, t("suspicious.done"))} />
        ) : queueView === "amounts" ? (
          <AmountDuplicatesPanel
            onMerge={(p) => {
              const groupsOf = (side: AmountPair["a"]) =>
                side.entityId != null ? (data?.groups ?? []).filter((g) => g.entityId === side.entityId) : [groupsByKey.get(side.key ?? "")].filter((g): g is PayeeGroupRow => g != null);
              const groups = [...groupsOf(p.a), ...groupsOf(p.b)];
              if (groups.length >= 2) mergeGroups(t("amountDup.merge"), groups);
            }}
          />
        ) : queueView === "bulk" ? (
          <BulkPanel types={merchantTypes} onDone={() => void mutate()} />
        ) : queueView === "people" ? (
          <PeoplePanel
            onAdd={(p) => {
              const groups = p.keys.map((k) => groupsByKey.get(k)).filter((g): g is PayeeGroupRow => g != null);
              if (groups.length) mergeGroups(t("people.addTitle", { name: p.name }), groups);
            }}
          />
        ) : (
          spellingsTable(query ? t("page.noPayeesMatch") : t("page.allInDirectory"))
        )}
      </div>
    );
  else if (section === "channels")
    body = (
      <div className="space-y-6">
        {notices}
        <OwnAccountsPanel onChanged={() => void mutate()} />
        <WhosePanel onChanged={() => void mutate()} />
        <section className="space-y-2" aria-label={t("merchants.service.title")}>
          <h3 className="text-sm font-medium inline-flex items-center gap-1">
            {t("merchants.service.title")} <HelpHint text={t("merchants.help.service")} />
          </h3>
          {serviceGroups.length === 0 ? (
            <EmptyState reason={t("merchants.service.none")} />
          ) : (
            <ul className="divide-y rounded-lg border text-sm">
              {serviceGroups.slice(0, 50).map((g) => (
                <li key={g.key} className="flex flex-wrap items-center gap-2 p-2">
                  <span className="font-medium break-all">{g.name}</span>
                  {typeCell(g)}
                  <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                    {t("common.tx", { n: g.count })} · {formatCurrency(g.total, currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <MinePanel onSaved={() => void mutate()} />
      </div>
    );
  else if (section === "dictionaries")
    body = (
      <div className="space-y-6">
        <section className="space-y-2" aria-label={t("page.merchantTypes")}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{t("page.merchantTypes")}</h3>
            <HelpHint text={t("merchants.help.types")} />
            <Button variant="outline" size="sm" className="ms-auto" onClick={() => setAction({ kind: "types" })}>
              {t("merchants.types.edit")}
            </Button>
          </div>
          <ul className="grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
            {groupMerchantTypes(merchantTypes).map((g) => (
              <li key={g.group} className="rounded-md border p-2">
                <span className="font-medium">{g.items[0] ? localizedType(g.items[0], t).group : g.group}</span>
                {g.items.length > 1 && <span className="block text-muted-foreground">{g.items.map((i) => localizedType(i, t).name).join(", ")}</span>}
              </li>
            ))}
          </ul>
        </section>
        <WordListsSection settings={data?.settings ?? null} onSave={saveSettings} onImported={() => void mutate()} />
        <PacksCard onChanged={() => void mutate()} />
      </div>
    );
  else
    body =
      (data?.batches ?? []).length === 0 ? (
        <EmptyState reason={t("common.noChanges")} />
      ) : (
        <ul className="divide-y rounded-lg border">
          {(data?.batches ?? []).map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
              <span className="font-medium">#{b.id}</span>
              <span>{batchLabel(b, t)}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{b.createdAt.slice(0, 16).replace("T", " ")}</span>
              <span className="ms-auto">
                {b.undoneAt ? (
                  <span className="text-xs text-muted-foreground">{t("common.undoneBadge")}</span>
                ) : b.canUndo ? (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAction({ kind: "undo", batch: b })}>
                    {t("common.undo")}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">{t("page.olderThan30")}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      );

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("page.title")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t("page.subtitle")}</p>
        </div>
        <MerchantSearchButton className="md:hidden" />
        <Button variant="outline" size="sm" aria-label={t("page.settingsAria")} title={t("page.settingsAria")} onClick={() => setSettingsOpen(true)}>
          <Settings2 className="h-4 w-4" />
          <span className="ms-1 hidden sm:inline">{t("page.settings")}</span>
        </Button>
      </div>

      <nav className="-mx-1 overflow-x-auto px-1" aria-label={t("merchants.sections")}>
        <div className="inline-flex min-w-max gap-1 border-b" role="tablist" aria-label={t("merchants.sections")}>
          {sectionTabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={section === x.id}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${section === x.id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              onClick={() => go({ tab: x.id === "overview" ? null : x.id, view: null, q: null })}
            >
              {x.label}
              {x.badge ? (
                <span className="rounded-full bg-action-caution px-1.5 text-[10px] font-semibold leading-4 text-action-caution-foreground" title={t("merchants.queueBadge", { n: x.badge })}>
                  {x.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </nav>

      <Card>
        <CardContent className="space-y-3 pt-4">{body}</CardContent>
      </Card>

      {settingsOpen && <StudioSettingsDialog settings={data?.settings ?? null} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}
      {drawer && (
        <PayeeDrawer
          group={drawer}
          currency={currency}
          onClose={() => setDrawer(null)}
          onAdd={(g) => {
            setDrawer(null);
            mergeGroups(t("page.addTitle", { name: g.name }), [g]);
          }}
          onExplain={(g) => {
            setDrawer(null);
            setExplain({ a: g.name, b: "" });
          }}
        />
      )}
      {undoToast.node}
      {explain && <ExplainDialog initialA={explain.a} initialB={explain.b} onClose={() => setExplain(null)} />}
      {action?.kind === "merge" && (
        <MergeDialog
          title={action.title}
          payees={action.payees}
          entityIds={action.entityIds}
          suggestedName={action.suggestedName}
          suggestedType={action.suggestedType}
          entities={entityOptions}
          merchantTypes={merchantTypes}
          typeHint={action.typeHint}
          clusterKeys={action.clusterKeys}
          warning={action.warning}
          onClose={() => setAction(null)}
          onDone={(r) => done(r)}
        />
      )}
      {action?.kind === "undo" && (
        <OpDialog
          title={t("common.undoTitle", { id: action.batch.id })}
          body={{ op: "undo", batchId: action.batch.id }}
          onClose={() => setAction(null)}
          onDone={(r) => done(r)}
          confirmLabel={t("common.undo")}
          intent="reject"
        >
          <p className="text-xs text-muted-foreground">{batchLabel(action.batch, t)}</p>
        </OpDialog>
      )}
      {action?.kind === "quick" && (
        <OpDialog title={action.title} body={action.body} onClose={() => setAction(null)} onDone={(r) => done(r)} confirmLabel={t("quick.confirm")} intent="confirm">
          <p className="text-xs text-muted-foreground">{action.note}</p>
        </OpDialog>
      )}
      {action?.kind === "setType" && (
        <SetMerchantTypeDialog
          types={merchantTypes}
          entityIds={[...pickedEntities].filter((id) => entities.some((e) => e.id === id))}
          onClose={() => setAction(null)}
          onDone={(r) => {
            setPickedEntities(new Set());
            void done(r, t("page.typeChanged", { n: r.typed?.length ?? 0 }));
          }}
        />
      )}
      {action?.kind === "types" && <MerchantTypesEditor types={merchantTypes} onClose={() => setAction(null)} onDone={(r) => done(r, t("page.typesSaved"))} />}
      {action?.kind === "applyAll" && (
        <OpDialog title={t("page.applyTitle")} body={{ op: "apply" }} onClose={() => setAction(null)} onDone={(r) => done(r)} confirmLabel={t("common.rename")}>
          <p className="text-xs text-muted-foreground">{t("page.applyNote")}</p>
        </OpDialog>
      )}
    </div>
  );
}
