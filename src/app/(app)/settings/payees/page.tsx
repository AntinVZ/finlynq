"use client";

/**
 * /settings/payees — Payee Studio.
 *
 * Every payee across transactions, recurring, staged imports, SimpleFIN
 * pending and the bank ledger (GET /api/payees). Spellings that are the same
 * name once letter case, apostrophes, Latin/Cyrillic transliteration and
 * card-terminal noise are ignored form one row; "Clusters" lists names that
 * only look alike, with a confidence and the reasons; "Unrecognized" lists
 * payees not yet in the directory. Private persons and sole proprietors are
 * flagged "needs decision" and never merged automatically.
 *
 * P2: the directory. Add a payee (its spellings become aliases), merge a
 * cluster or selected payees into one, open an entry to edit it. Every
 * change is previewed first ("renames N rows in transactions, …") and
 * becomes a batch that "Changes" can undo for 30 days. On small screens the
 * table becomes a list of cards.
 *
 * P3/P4: link to AI review, import-hint / autopilot switches, an Insights
 * tab (top counterparties, monthly spend, new / gone, regular ones,
 * concentration) and dictionary export / import.
 *
 * P5a: the settings (and the dictionary file) live behind the gear at the
 * top; a summary strip shows payees / not in the directory / merge
 * candidates / auto-replace state with "Review with AI"; the page opens on
 * Clusters when there are any, else Unrecognized; long lists page by 25 / 50;
 * a payee that is not in the directory opens a side panel (totals, dates,
 * categories, spellings, "Add to directory", "Show transactions");
 * "Explain" says why two payees are (not) clustered.
 */

import { useMemo, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { PERSONS_MERCHANT_GROUP } from "@/lib/payees/payee-type";
import { groupMerchantTypes, merchantTypeLabel, MerchantTypesEditor, PayeeTypeLabel, SetMerchantTypeDialog } from "./_components/merchant-type-ui";
import { OpDialog, describeRows, type OpPreview } from "./_components/op-dialog";
import { InsightsPanel } from "./_components/insights-panel";
import { StudioSettingsDialog } from "./_components/settings-dialog";
import { SuspiciousPanel } from "./_components/suspicious-panel";
import { OwnAccountsPanel } from "./_components/own-accounts-panel";
import { BulkPanel, PeoplePanel } from "./_components/bulk-panel";
import { useStudioT, type StudioT } from "./_components/i18n";
import { PayeeDrawer } from "./_components/payee-drawer";
import { ExplainDialog } from "./_components/explain-dialog";
import { LookalikesPanel } from "./_components/lookalikes-panel";
import { MinePanel } from "./_components/mine-panel";
import { WhosePanel } from "./_components/whose-panel";

const PAGE_SIZES = [25, 50] as const;

type Tab = "all" | "clusters" | "lookalikes" | "unrecognized" | "directory" | "bulk" | "people" | "suspicious" | "requisites" | "changes" | "insights";
type SortKey = "count" | "name" | "total" | "lastDate";

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

export default function PayeesSettingsPage() {
  const t = useStudioT();
  const [tabChoice, setTab] = useState<Tab | null>(null);
  const [pageState, setPageState] = useState({ key: "", page: 0 });
  const [pageSize, setPageSize] = useState<number>(25);
  const [drawer, setDrawer] = useState<PayeeGroupRow | null>(null);
  const [explain, setExplain] = useState<{ a: string; b: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "count", dir: "desc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action | null>(null);
  /** P6: Directory filter by merchant type ("" all, "none" untyped, else a group) and selected entries. */
  const [typeFilter, setTypeFilter] = useState("");
  const [pickedEntities, setPickedEntities] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState("");

  const { data, error: loadErr, mutate } = useSWR<PayeesResponse>("/api/payees", jsonFetcher, { revalidateOnFocus: false });
  const loadError = loadErr ? t("page.loadFailed") : "";
  // Open on Clusters when there are merge candidates, else on Unrecognized.
  const tab: Tab = tabChoice ?? (data && data.clusters.length === 0 ? "unrecognized" : "clusters");
  // The page resets whenever the tab, the search or the page size changes.
  const pageKey = `${tab}\u0000${query}\u0000${pageSize}`;
  const page = pageState.key === pageKey ? pageState.page : 0;
  const setPage = (fn: (p: number) => number) => setPageState({ key: pageKey, page: fn(page) });
  const currency = data?.currency ?? "USD";
  const entities = useMemo(() => data?.entities ?? [], [data]);
  const entityOptions = useMemo(
    () => entities.map((e) => ({ id: e.id, name: e.name, type: e.type, merchantType: e.merchantType ?? null, count: e.count, aliasCount: e.aliasCount, aliases: e.aliasNames ?? [] })),
    [entities],
  );

  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const groupsByKey = useMemo(() => new Map((data?.groups ?? []).map((g) => [g.key, g])), [data]);

  const rows = useMemo(() => {
    let list = (data?.groups ?? []).filter((g) => g.key);
    if (tab === "unrecognized") list = list.filter((g) => g.entityId == null);
    if (query.trim()) list = list.filter((g) => g.spellings.some((s) => containsNormalized(s.spelling, query)) || (g.entityName != null && containsNormalized(g.entityName, query)));
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sort.key === "name") return a.name.localeCompare(b.name) * dir;
      if (sort.key === "total") return (Math.abs(a.total) - Math.abs(b.total)) * dir || a.name.localeCompare(b.name);
      if (sort.key === "lastDate") return (a.lastDate ?? "").localeCompare(b.lastDate ?? "") * dir;
      return (a.count - b.count) * dir || (a.rows - b.rows) * dir || a.name.localeCompare(b.name);
    });
  }, [data, tab, query, sort]);

  const clusters = useMemo(() => {
    const list = data?.clusters ?? [];
    if (!query.trim()) return list;
    return list.filter((c) => c.keys.some((k) => groupsByKey.get(k)?.spellings.some((s) => containsNormalized(s.spelling, query))));
  }, [data, query, groupsByKey]);

  const entityRows = useMemo(() => {
    let list = query.trim() ? entities.filter((e) => containsNormalized(e.name, query)) : entities;
    if (typeFilter === "none") list = list.filter((e) => !e.merchantType);
    else if (typeFilter) list = list.filter((e) => e.merchantType?.group === typeFilter);
    return list;
  }, [entities, query, typeFilter]);
  const merchantTypes = useMemo(() => data?.merchantTypes ?? [], [data]);

  const unrecognizedCount = useMemo(() => (data?.groups ?? []).filter((g) => g.key && g.entityId == null).length, [data]);
  const payeeCount = useMemo(() => (data?.groups ?? []).filter((g) => g.key).length, [data]);
  const pageRows = useMemo(() => rows.slice(page * pageSize, (page + 1) * pageSize), [rows, page, pageSize]);
  const pageEntities = useMemo(() => entityRows.slice(page * pageSize, (page + 1) * pageSize), [entityRows, page, pageSize]);
  const blank = data?.groups.find((g) => !g.key);
  const selectedGroups = useMemo(() => (data?.groups ?? []).filter((g) => selected.has(g.key)), [data, selected]);

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

  async function done(r: OpPreview, message?: string) {
    setAction(null);
    setSelected(new Set());
    setStatus(message ?? (r.undo ? t("common.undone", { n: r.undo.restoredRows }) : t("common.saved", { rows: describeRows(r, t) })));
    await mutate();
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
      <Link href={`/settings/payees/${g.entityId}`} className="font-medium hover:underline break-all">
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
          <select aria-label={t("page.rowsPerPage")} className="h-7 rounded-md border bg-background px-1" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
    ) : null;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "all", label: `${t("page.tab.all")}${data ? ` (${data.groups.filter((g) => g.key).length})` : ""}` },
    { id: "clusters", label: `${t("page.tab.clusters")}${data ? ` (${data.clusters.length})` : ""}` },
    { id: "lookalikes", label: `${t("page.tab.lookalikes")}${data ? ` (${data.lookalikeCount ?? 0})` : ""}` },
    { id: "unrecognized", label: `${t("page.tab.unrecognized")}${data ? ` (${unrecognizedCount})` : ""}` },
    { id: "directory", label: `${t("page.tab.directory")}${data ? ` (${entities.length})` : ""}` },
    { id: "bulk", label: t("bulk.tab") },
    { id: "people", label: t("people.tab") },
    { id: "suspicious", label: `${t("suspicious.tab")}${data ? ` (${data.suspicious?.length ?? 0})` : ""}` },
    { id: "requisites", label: t("page.tab.requisites") },
    { id: "changes", label: t("page.tab.changes") },
    { id: "insights", label: t("page.tab.insights") },
  ];

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("page.title")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t("page.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" aria-label={t("page.settingsAria")} title={t("page.settingsAria")} onClick={() => setSettingsOpen(true)}>
          <Settings2 className="h-4 w-4" />
          <span className="ms-1 hidden sm:inline">{t("page.settings")}</span>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" aria-label={t("page.summary")}>
        {[
          { label: t("page.title"), value: data ? String(payeeCount) : "…", onClick: () => setTab("all") },
          { label: t("page.sum.notInDirectory"), value: data ? String(unrecognizedCount) : "…", onClick: () => setTab("unrecognized") },
          { label: t("page.sum.mergeCandidates"), value: data ? String(data.clusters.length) : "…", onClick: () => setTab("clusters") },
          { label: t("page.sum.newLookalikes"), value: data ? String(data.lookalikeCount ?? 0) : "…", onClick: () => setTab("lookalikes") },
          { label: t("page.sum.autoReplace"), value: data ? (data.settings.importHint ? t("page.on") : t("page.off")) : "…", onClick: () => setSettingsOpen(true) },
        ].map((c) => (
          <button key={c.label} type="button" onClick={c.onClick} className="rounded-lg border p-2 text-start hover:bg-accent/50">
            <span className="block text-xs text-muted-foreground">{c.label}</span>
            <span className="block text-lg font-semibold tabular-nums">{c.value}</span>
          </button>
        ))}
        <Link href="/settings/payees/review" className="rounded-lg border p-2 hover:bg-accent/50">
          <span className="block text-xs text-muted-foreground">{t("page.aiAssistant")}</span>
          <span className="flex items-center gap-1 text-sm font-medium">
            {t("page.reviewWithAi")}
            {data?.draftCount ? <Badge variant="secondary">{t("page.waiting", { n: data.draftCount })}</Badge> : null}
          </span>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("page.studio")}</CardTitle>
          <CardDescription>{t("page.intro")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex flex-wrap rounded-md border p-0.5" role="tablist" aria-label={t("page.views")}>
              {tabs.map((x) => (
                <Button
                  key={x.id}
                  role="tab"
                  aria-selected={tab === x.id}
                  variant={tab === x.id ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setTab(x.id)}
                >
                  {x.label}
                </Button>
              ))}
            </div>
            <div className="relative flex-1 min-w-48">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="ps-8" placeholder={t("page.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {(tab === "all" || tab === "unrecognized") && (
              <Button
                variant="outline"
                size="sm"
                disabled={selectedGroups.length < 2}
                onClick={() => mergeGroups(t("page.mergeTitle", { n: selectedGroups.length }), selectedGroups)}
              >
                {t("page.mergeSelected")}{selectedGroups.length >= 2 ? ` (${selectedGroups.length})` : ""}
              </Button>
            )}
            {(tab === "all" || tab === "unrecognized" || tab === "clusters") && (
              <Button
                variant="ghost"
                size="sm"
                title={t("page.explainTitle")}
                onClick={() => setExplain({ a: selectedGroups[0]?.name ?? "", b: selectedGroups[1]?.name ?? "" })}
              >
                {t("common.explain")}
              </Button>
            )}
            {tab === "directory" && entities.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setAction({ kind: "applyAll" })}>
                {t("page.applyDirectory")}
              </Button>
            )}
            {tab === "directory" && (
              <>
                <select
                  aria-label={t("page.typeFilter")}
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={typeFilter}
                  onChange={(ev) => setTypeFilter(ev.target.value)}
                >
                  <option value="">{t("page.allTypes")}</option>
                  <option value="none">{t("page.untyped")}</option>
                  {groupMerchantTypes(merchantTypes).map((g) => (
                    <option key={g.group} value={g.group}>
                      {g.group}
                    </option>
                  ))}
                </select>
                <Button variant="outline" size="sm" disabled={!entities.length} onClick={() => setAction({ kind: "setType" })}>
                  {t("page.setType")}{pickedEntities.size ? ` (${pickedEntities.size})` : ""}…
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAction({ kind: "types" })}>
                  {t("page.merchantTypes")}
                </Button>
              </>
            )}
          </div>

          {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {data && data.truncated.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("page.truncated", { list: data.truncated.join(", ") })}
            </p>
          )}
          {data && data.undecryptable > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("page.undecryptable", { n: data.undecryptable })}
            </p>
          )}
          {blank && blank.count > 0 && (tab === "all" || tab === "unrecognized") && (
            <p className="text-xs text-muted-foreground">{t("page.blank", { n: blank.count })}</p>
          )}

          {!data && !loadError ? (
            <p className="text-sm text-muted-foreground">{t("page.loading")}</p>
          ) : tab === "insights" ? (
            <InsightsPanel />
          ) : tab === "bulk" ? (
            <BulkPanel types={merchantTypes} onDone={() => mutate()} />
          ) : tab === "people" ? (
            <PeoplePanel
              onAdd={(p) => {
                const groups = p.keys.map((k) => groupsByKey.get(k)).filter((g): g is PayeeGroupRow => g != null);
                if (groups.length) mergeGroups(t("people.addTitle", { name: p.name }), groups);
              }}
            />
          ) : tab === "suspicious" ? (
            <SuspiciousPanel rows={data?.suspicious ?? []} entities={entityOptions} onDone={(r) => done(r, t("suspicious.done"))} />
          ) : tab === "lookalikes" ? (
            <LookalikesPanel onChanged={() => mutate()} />
          ) : tab === "requisites" ? (
            <div className="space-y-6">
              <OwnAccountsPanel onChanged={() => mutate()} />
              <WhosePanel onChanged={() => mutate()} />
              <MinePanel onSaved={() => mutate()} />
            </div>
          ) : tab === "clusters" ? (
            clusters.length === 0 ? (
              <p className="text-sm text-muted-foreground">{query ? t("page.noClustersMatch") : t("page.noClusters")}</p>
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
                    <div className="flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() =>
                          mergeGroups(
                            t("page.mergeOne"),
                            c.keys.map((k) => groupsByKey.get(k)).filter((g): g is PayeeGroupRow => !!g),
                            c,
                          )
                        }
                      >
                        {t("page.mergeEllipsis")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : tab === "directory" ? (
            entityRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {query ? t("page.noEntriesMatch") : t("page.directoryEmpty")}
              </p>
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
                    <Link href={`/settings/payees/${e.id}`} className="font-medium hover:underline break-all">
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
                        <span
                          className={`text-muted-foreground ${e.merchantTypeHint.strength === "weak" ? "opacity-70 italic" : ""}`}
                          title={t("page.hintTitle", { reason: e.merchantTypeHint.reason })}
                        >
                          — ({e.merchantTypeHint.strength === "weak" ? t("page.weakHintLower") : t("page.hintLower")}: {merchantTypeLabel(e.merchantTypeHint, t)}
                          {e.merchantTypeHint.strength === "weak" ? `, ${e.merchantTypeHint.reason}` : ""})
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
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
            )
          ) : tab === "changes" ? (
            (data?.batches ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("common.noChanges")}</p>
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
            )
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{query ? t("page.noPayeesMatch") : tab === "unrecognized" ? t("page.allInDirectory") : t("page.noPayees")}</p>
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
                        {g.categories.length > 0 && (
                          <p className="text-xs text-muted-foreground truncate">{g.categories.map((c) => c.name).join(", ")}</p>
                        )}
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
                          {g.entityName && g.entityName !== g.name && (
                            <p className="text-xs text-muted-foreground">{t("page.asSpelling", { name: g.name })}</p>
                          )}
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
              {data && data.totalGroups > data.groups.length && (
                <p className="text-xs text-muted-foreground">{t("page.showingMostUsed", { n: data.groups.length, total: data.totalGroups })}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {settingsOpen && (
        <StudioSettingsDialog settings={data?.settings ?? null} onSave={saveSettings} onClose={() => setSettingsOpen(false)} onImported={() => mutate()} />
      )}
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
        >
          <p className="text-xs text-muted-foreground">{batchLabel(action.batch, t)}</p>
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
