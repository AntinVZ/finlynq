"use client";

/**
 * /settings/payees — Payee Studio overview.
 *
 * Every payee across transactions, recurring, staged imports, SimpleFIN
 * pending and the bank ledger (GET /api/payees). Spellings that are the same
 * name once letter case, apostrophes, Latin/Cyrillic transliteration and
 * card-terminal noise are ignored form one row; "Clusters" lists names that
 * only look alike, with a confidence and the reasons; "Unrecognized" lists
 * payees not yet linked to the directory. Private persons and sole
 * proprietors are flagged "needs decision" and never merged automatically.
 * On small screens the table becomes a list of cards.
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { containsNormalized } from "@/lib/text-normalize";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { confidenceBadge, needsDecisionBadge, typeLabel, type PayeeGroupRow, type PayeesResponse } from "./_components/payee-ui";

type Tab = "all" | "clusters" | "unrecognized";
type SortKey = "count" | "name" | "total" | "lastDate";

export default function PayeesSettingsPage() {
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "count", dir: "desc" });

  const { data, error: loadErr } = useSWR<PayeesResponse>("/api/payees", jsonFetcher, { revalidateOnFocus: false });
  const loadError = loadErr ? "Couldn't load payees." : "";
  const currency = data?.currency ?? "USD";

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

  const unrecognizedCount = useMemo(() => (data?.groups ?? []).filter((g) => g.key && g.entityId == null).length, [data]);
  const blank = data?.groups.find((g) => !g.key);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));
  }
  const sortIcon = (key: SortKey) =>
    sort.key === key ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null;

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
  const payeeLink = (g: PayeeGroupRow) => (
    <Link href={buildTxDrillUrl({ search: g.name })} className="font-medium hover:underline break-all">
      {g.entityName ?? g.name}
    </Link>
  );
  const typeCell = (g: PayeeGroupRow) => (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={g.type.confidence < 0.5 ? "text-muted-foreground" : undefined} title={g.type.reason}>
        {typeLabel(g.type.type)}
      </span>
      {g.type.isPerson && g.entityId == null && needsDecisionBadge(g.type.reason)}
    </span>
  );

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "all", label: `All${data ? ` (${data.groups.filter((g) => g.key).length})` : ""}` },
    { id: "clusters", label: `Clusters${data ? ` (${data.clusters.length})` : ""}` },
    { id: "unrecognized", label: `Unrecognized${data ? ` (${unrecognizedCount})` : ""}` },
  ];

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Payees</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Every merchant, service and person you pay or get paid by, with the spellings they come in
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payee overview</CardTitle>
          <CardDescription>
            Names that differ only in letter case, apostrophes, Latin/Cyrillic spelling or card-terminal noise
            (store codes, city, long numbers) are shown as one payee. Clusters are names that only look alike —
            check the reasons before merging. People are never merged automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="Payee views">
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
          </div>

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
          {blank && blank.count > 0 && tab !== "clusters" && (
            <p className="text-xs text-muted-foreground">{blank.count} transaction(s) have no payee.</p>
          )}

          {!data && !loadError ? (
            <p className="text-sm text-muted-foreground">Loading… (payees are decrypted and grouped on the server; large ledgers take a few seconds)</p>
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
                {rows.map((g) => (
                  <li key={g.key} className="rounded-lg border p-3 text-sm">
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
                  </li>
                ))}
              </ul>
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b">
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
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((g) => (
                      <tr key={g.key} className="border-b last:border-0 align-top">
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data && data.totalGroups > data.groups.length && (
                <p className="text-xs text-muted-foreground">Showing the {data.groups.length} most used of {data.totalGroups} payees.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
