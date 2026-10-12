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

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowDown, ArrowUp, Search, Settings2 } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { containsNormalized } from "@/lib/text-normalize";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import {
  batchLabel,
  confidenceBadge,
  needsDecisionBadge,
  PayeeAvatar,
  typeLabel,
  type BatchRow,
  type PayeeClusterRow,
  type PayeeGroupRow,
  type PayeesResponse,
} from "./_components/payee-ui";
import { MergeDialog } from "./_components/merge-dialog";
import { OpDialog, describeRows, type OpPreview } from "./_components/op-dialog";
import { InsightsPanel } from "./_components/insights-panel";
import { StudioSettingsDialog } from "./_components/settings-dialog";
import { PayeeDrawer } from "./_components/payee-drawer";
import { ExplainDialog } from "./_components/explain-dialog";
import { LookalikesPanel } from "./_components/lookalikes-panel";

const PAGE_SIZES = [25, 50] as const;

type Tab = "all" | "clusters" | "lookalikes" | "unrecognized" | "directory" | "changes" | "insights";
type SortKey = "count" | "name" | "total" | "lastDate";

type Action =
  | { kind: "merge"; title: string; payees: string[]; entityIds: number[]; suggestedName: string; suggestedType: string; warning: string | null }
  | { kind: "undo"; batch: BatchRow }
  | { kind: "applyAll" };

export default function PayeesSettingsPage() {
  const [tabChoice, setTab] = useState<Tab | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(25);
  const [drawer, setDrawer] = useState<PayeeGroupRow | null>(null);
  const [explain, setExplain] = useState<{ a: string; b: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "count", dir: "desc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action | null>(null);
  const [status, setStatus] = useState("");

  const { data, error: loadErr, mutate } = useSWR<PayeesResponse>("/api/payees", jsonFetcher, { revalidateOnFocus: false });
  const loadError = loadErr ? "Couldn't load payees." : "";
  // Open on Clusters when there are merge candidates, else on Unrecognized.
  const tab: Tab = tabChoice ?? (data && data.clusters.length === 0 ? "unrecognized" : "clusters");
  useEffect(() => setPage(0), [tab, query, pageSize]);
  const currency = data?.currency ?? "USD";
  const entities = useMemo(() => data?.entities ?? [], [data]);
  const entityOptions = useMemo(() => entities.map((e) => ({ id: e.id, name: e.name, type: e.type })), [entities]);

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

  const entityRows = useMemo(
    () => (query.trim() ? entities.filter((e) => containsNormalized(e.name, query)) : entities),
    [entities, query],
  );

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
    setAction({
      kind: "merge",
      title,
      payees: groups.filter((g) => g.entityId == null).flatMap((g) => g.spellings.map((s) => s.spelling)),
      entityIds: [...new Set(groups.map((g) => g.entityId).filter((id): id is number => id != null))],
      suggestedName: cluster?.suggestedName ?? lead?.entityName ?? lead?.suggestedName ?? "",
      suggestedType: cluster?.suggestedType.type ?? lead?.type.type ?? "other",
      warning:
        people.length && people.length < groups.length
          ? "This mixes a private person or sole proprietor with other payees. People are never merged automatically — only continue if they really are the same counterparty."
          : cluster?.decisionReason ?? null,
    });
  }

  async function done(r: OpPreview, message?: string) {
    setAction(null);
    setSelected(new Set());
    setStatus(message ?? (r.undo ? `Undone: restored ${r.undo.restoredRows} row(s).` : `Saved. ${describeRows(r)}`));
    await mutate();
  }

  async function saveSettings(patch: Record<string, unknown>) {
    await fetch("/api/payees/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
    await mutate();
  }

  const spellingsBadge = (g: PayeeGroupRow) =>
    g.spellings.length > 1 ? (
      <Badge
        variant="outline"
        className="ml-2 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300"
        title={g.spellings.map((s) => `"${s.spelling}" × ${s.count}`).join(", ")}
      >
        {g.spellings.length} spellings
      </Badge>
    ) : null;
  const payeeLink = (g: PayeeGroupRow) =>
    g.entityId != null ? (
      <Link href={`/settings/payees/${g.entityId}`} className="font-medium hover:underline break-all">
        {g.entityName ?? g.name}
      </Link>
    ) : (
      <button type="button" className="font-medium hover:underline break-all text-left" onClick={() => setDrawer(g)}>
        {g.name}
      </button>
    );
  const typeCell = (g: PayeeGroupRow) => (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={g.type.confidence < 0.5 ? "text-muted-foreground" : undefined} title={g.type.reason}>
        {typeLabel(g.type.type)}
      </span>
      {g.type.isPerson && g.entityId == null && needsDecisionBadge(g.type.reason)}
    </span>
  );
  const rowAction = (g: PayeeGroupRow) =>
    g.entityId == null ? (
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => mergeGroups(`Add “${g.name}” to the directory`, [g])}>
        Add to directory
      </Button>
    ) : null;
  const checkbox = (g: PayeeGroupRow) => (
    <input type="checkbox" aria-label={`Select ${g.name}`} checked={selected.has(g.key)} onChange={() => toggle(g.key)} />
  );

  const pager = (total: number) =>
    total > PAGE_SIZES[0] ? (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Pages">
        <span className="tabular-nums">
          {page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total}
        </span>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((p) => p + 1)}>
          Next
        </Button>
        <label className="ml-auto inline-flex items-center gap-1">
          Per page
          <select aria-label="Rows per page" className="h-7 rounded-md border bg-background px-1" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
    ) : null;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "all", label: `All${data ? ` (${data.groups.filter((g) => g.key).length})` : ""}` },
    { id: "clusters", label: `Clusters${data ? ` (${data.clusters.length})` : ""}` },
    { id: "lookalikes", label: `Look-alikes${data ? ` (${data.lookalikeCount ?? 0})` : ""}` },
    { id: "unrecognized", label: `Unrecognized${data ? ` (${unrecognizedCount})` : ""}` },
    { id: "directory", label: `Directory${data ? ` (${entities.length})` : ""}` },
    { id: "changes", label: "Changes" },
    { id: "insights", label: "Insights" },
  ];

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Payees</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Every merchant, service and person you pay or get paid by, with the spellings they come in
          </p>
        </div>
        <Button variant="outline" size="sm" aria-label="Studio settings" title="Studio settings" onClick={() => setSettingsOpen(true)}>
          <Settings2 className="h-4 w-4" />
          <span className="ml-1 hidden sm:inline">Settings</span>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" aria-label="Summary">
        {[
          { label: "Payees", value: data ? String(payeeCount) : "…", onClick: () => setTab("all") },
          { label: "Not in directory", value: data ? String(unrecognizedCount) : "…", onClick: () => setTab("unrecognized") },
          { label: "Merge candidates", value: data ? String(data.clusters.length) : "…", onClick: () => setTab("clusters") },
          { label: "New look-alikes", value: data ? String(data.lookalikeCount ?? 0) : "…", onClick: () => setTab("lookalikes") },
          { label: "Auto-replace", value: data ? (data.settings.importHint ? "ON" : "OFF") : "…", onClick: () => setSettingsOpen(true) },
        ].map((c) => (
          <button key={c.label} type="button" onClick={c.onClick} className="rounded-lg border p-2 text-left hover:bg-accent/50">
            <span className="block text-xs text-muted-foreground">{c.label}</span>
            <span className="block text-lg font-semibold tabular-nums">{c.value}</span>
          </button>
        ))}
        <Link href="/settings/payees/review" className="rounded-lg border p-2 hover:bg-accent/50">
          <span className="block text-xs text-muted-foreground">AI assistant</span>
          <span className="flex items-center gap-1 text-sm font-medium">
            Review with AI
            {data?.draftCount ? <Badge variant="secondary">{data.draftCount} waiting</Badge> : null}
          </span>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payee Studio</CardTitle>
          <CardDescription>
            Names that differ only in letter case, apostrophes, Latin/Cyrillic spelling or card-terminal noise
            (store codes, city, long numbers) are shown as one payee. Clusters are names that only look alike —
            check the reasons before merging. People are never merged automatically. Merging renames the stored
            payees to one canonical name (the old spellings are kept as aliases); bank statement rows are never
            changed, and every change can be undone for 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex flex-wrap rounded-md border p-0.5" role="tablist" aria-label="Payee views">
              {tabs.map((t) => (
                <Button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  variant={tab === t.id ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search payees…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {(tab === "all" || tab === "unrecognized") && (
              <Button
                variant="outline"
                size="sm"
                disabled={selectedGroups.length < 2}
                onClick={() => mergeGroups(`Merge ${selectedGroups.length} payees`, selectedGroups)}
              >
                Merge selected{selectedGroups.length >= 2 ? ` (${selectedGroups.length})` : ""}
              </Button>
            )}
            {(tab === "all" || tab === "unrecognized" || tab === "clusters") && (
              <Button
                variant="ghost"
                size="sm"
                title="Why are two payees (not) clustered?"
                onClick={() => setExplain({ a: selectedGroups[0]?.name ?? "", b: selectedGroups[1]?.name ?? "" })}
              >
                Explain…
              </Button>
            )}
            {tab === "directory" && entities.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setAction({ kind: "applyAll" })}>
                Apply directory to payees
              </Button>
            )}
          </div>

          {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {data && data.truncated.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Some tables have more rows than this page reads at once ({data.truncated.join(", ")}); counts may be incomplete.
            </p>
          )}
          {data && data.undecryptable > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {data.undecryptable} payee value(s) couldn&apos;t be decrypted and are not shown.
            </p>
          )}
          {blank && blank.count > 0 && (tab === "all" || tab === "unrecognized") && (
            <p className="text-xs text-muted-foreground">{blank.count} transaction(s) have no payee.</p>
          )}

          {!data && !loadError ? (
            <p className="text-sm text-muted-foreground">Loading… (payees are decrypted and grouped on the server; large ledgers take a few seconds)</p>
          ) : tab === "insights" ? (
            <InsightsPanel />
          ) : tab === "lookalikes" ? (
            <LookalikesPanel onChanged={() => mutate()} />
          ) : tab === "clusters" ? (
            clusters.length === 0 ? (
              <p className="text-sm text-muted-foreground">{query ? "No clusters match." : "No look-alike payees found."}</p>
            ) : (
              <ul className="space-y-2">
                {clusters.map((c) => (
                  <li key={c.id} className="rounded-lg border p-3 text-sm space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.suggestedName || "—"}</span>
                      {confidenceBadge(c.confidence)}
                      <span className="text-xs text-muted-foreground">{typeLabel(c.suggestedType.type)}</span>
                      {c.needsDecision && needsDecisionBadge(c.decisionReason)}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {c.count} tx · {formatCurrency(c.total, currency)}
                      </span>
                    </div>
                    <ul className="text-xs text-muted-foreground list-disc pl-5">
                      {c.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                      {c.decisionReason && <li className="text-rose-700 dark:text-rose-300">{c.decisionReason}</li>}
                    </ul>
                    <div className="flex flex-wrap gap-1.5">
                      {c.keys.flatMap((k) =>
                        (groupsByKey.get(k)?.spellings ?? []).map((s) => (
                          <Badge key={`${k}|${s.spelling}`} variant="secondary" className="font-normal">
                            {s.spelling} <span className="ml-1 text-muted-foreground">× {s.count}</span>
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
                            `Merge into one payee`,
                            c.keys.map((k) => groupsByKey.get(k)).filter((g): g is PayeeGroupRow => !!g),
                            c,
                          )
                        }
                      >
                        Merge…
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : tab === "directory" ? (
            entityRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {query ? "No directory entries match." : "The directory is empty. Add payees from All, Unrecognized or Clusters."}
              </p>
            ) : (
              <>
              <ul className="divide-y rounded-lg border">
                {pageEntities.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                    <PayeeAvatar id={e.id} name={e.name} hasLogo={e.hasLogo} />
                    <Link href={`/settings/payees/${e.id}`} className="font-medium hover:underline break-all">
                      {e.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">{typeLabel(e.type)}</span>
                    <span className="text-xs text-muted-foreground">
                      {e.aliasCount} alias{e.aliasCount === 1 ? "" : "es"}
                      {data?.settings.advancedMode && e.identifierCount ? ` · ${e.identifierCount} requisite(s)` : ""}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {e.count} tx · {formatCurrency(e.total, currency)}
                      {e.lastDate ? ` · last ${e.lastDate}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {pager(entityRows.length)}
              </>
            )
          ) : tab === "changes" ? (
            (data?.batches ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No changes yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {(data?.batches ?? []).map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                    <span className="font-medium">#{b.id}</span>
                    <span>{batchLabel(b)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{b.createdAt.slice(0, 16).replace("T", " ")}</span>
                    <span className="ml-auto">
                      {b.undoneAt ? (
                        <span className="text-xs text-muted-foreground">Undone</span>
                      ) : b.canUndo ? (
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAction({ kind: "undo", batch: b })}>
                          Undo
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Older than 30 days</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{query ? "No payees match." : tab === "unrecognized" ? "Every payee is in the directory." : "No payees yet."}</p>
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
                          {g.count} tx · {formatCurrency(g.total, currency)} · {g.firstDate ?? "—"} → {g.lastDate ?? "—"}
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
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="w-8 py-2" />
                      <th className="py-2 pr-2">
                        <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("name")}>
                          Payee {sortIcon("name")}
                        </button>
                      </th>
                      <th className="py-2 pr-2">Type</th>
                      <th className="py-2 pr-2 text-right">
                        <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("count")}>
                          Transactions {sortIcon("count")}
                        </button>
                      </th>
                      <th className="py-2 pr-2 text-right">
                        <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("total")}>
                          Total ({currency}) {sortIcon("total")}
                        </button>
                      </th>
                      <th className="py-2 pr-2">First</th>
                      <th className="py-2 pr-2">
                        <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("lastDate")}>
                          Last {sortIcon("lastDate")}
                        </button>
                      </th>
                      <th className="py-2 pr-2">Accounts</th>
                      <th className="py-2 pr-2">Categories</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((g) => (
                      <tr key={g.key} className="border-b last:border-0 align-top">
                        <td className="py-2">{checkbox(g)}</td>
                        <td className="py-2 pr-2">
                          <div className="flex flex-wrap items-center">
                            {payeeLink(g)}
                            {spellingsBadge(g)}
                          </div>
                          {g.entityName && g.entityName !== g.name && (
                            <p className="text-xs text-muted-foreground">as &ldquo;{g.name}&rdquo;</p>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-xs">{typeCell(g)}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">
                          {g.count}
                          {g.rows > g.count && (
                            <span className="block text-xs text-muted-foreground" title="Rows in recurring, staged, pending and bank-ledger tables">
                              +{g.rows - g.count} other
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatCurrency(g.total, currency)}</td>
                        <td className="py-2 pr-2 text-xs tabular-nums">{g.firstDate ?? "—"}</td>
                        <td className="py-2 pr-2 text-xs tabular-nums">{g.lastDate ?? "—"}</td>
                        <td className="py-2 pr-2 text-xs text-muted-foreground max-w-40 truncate">{g.accounts.map((a) => a.name).join(", ") || "—"}</td>
                        <td className="py-2 pr-2 text-xs text-muted-foreground max-w-48 truncate">{g.categories.map((c) => c.name).join(", ") || "—"}</td>
                        <td className="py-2 text-right whitespace-nowrap">{rowAction(g)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pager(rows.length)}
              {data && data.totalGroups > data.groups.length && (
                <p className="text-xs text-muted-foreground">Showing the {data.groups.length} most used of {data.totalGroups} payees.</p>
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
            mergeGroups(`Add “${g.name}” to the directory`, [g]);
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
          warning={action.warning}
          onClose={() => setAction(null)}
          onDone={(r) => done(r)}
        />
      )}
      {action?.kind === "undo" && (
        <OpDialog
          title={`Undo change #${action.batch.id}`}
          body={{ op: "undo", batchId: action.batch.id }}
          onClose={() => setAction(null)}
          onDone={(r) => done(r)}
          confirmLabel="Undo"
        >
          <p className="text-xs text-muted-foreground">{batchLabel(action.batch)}</p>
        </OpDialog>
      )}
      {action?.kind === "applyAll" && (
        <OpDialog title="Apply the directory to stored payees" body={{ op: "apply" }} onClose={() => setAction(null)} onDone={(r) => done(r)} confirmLabel="Rename">
          <p className="text-xs text-muted-foreground">
            Every payee that matches a directory entry is renamed to its canonical name.
          </p>
        </OpDialog>
      )}
    </div>
  );
}
