"use client";

/**
 * /settings/tags — every tag on your transactions, with rename, merge and
 * delete.
 *
 * Tags aren't stored in a table: they live in each transaction's tag list,
 * so this page reads them from GET /api/tags (counted across ALL
 * transactions) and every change goes through POST /api/tags, which rewrites
 * the affected transactions. Before a change the dialog asks the server how
 * many transactions it touches (`dryRun`) and says when a rename lands on an
 * existing tag (that merges them). Deleting a tag only removes it from
 * transactions.
 *
 * S2: a Tree view reads tags with "/" (`команда/Іваненко`) as a hierarchy, with
 * per-branch counts the server rolls up over distinct transactions
 * (`?tree=1`), and can rename a whole branch (`op: "rename_prefix"`). The
 * "Multiple spellings" filter lists tags stored under several spellings, and
 * "Normalize spelling" rewrites them to the most used one
 * (`op: "normalize"`). Business / personal columns split each count. On
 * small screens the table becomes a list of cards.
 */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Search } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { containsNormalized } from "@/lib/text-normalize";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";

type TagRow = {
  tag: string;
  key: string;
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  spellings: Array<{ spelling: string; count: number }>;
  hasVariants: boolean;
  businessCount: number;
  personalCount: number;
  total: number;
};

type TreeNode = {
  path: string;
  key: string;
  name: string;
  depth: number;
  parentKey: string | null;
  isTag: boolean;
  count: number;
  ownCount: number;
  businessCount: number;
  personalCount: number;
  tagCount: number;
  childCount: number;
  total: number;
};

type TagsResponse = { tags: TagRow[]; tree?: TreeNode[]; currency: string; truncated: boolean };

type Action =
  | { kind: "rename"; tag: TagRow }
  | { kind: "merge"; tags: TagRow[] }
  | { kind: "delete"; tags: TagRow[] }
  | { kind: "prefix"; node: TreeNode }
  | { kind: "normalize"; tags: TagRow[] };

type Preview = {
  affected: number;
  targetExists?: boolean;
  targetCount?: number;
  tooLarge: boolean;
  truncated: boolean;
  // rename_prefix
  tagCount?: number;
  collisions?: string[];
  // normalize
  tags?: Array<{ tag: string; variants: string[] }>;
};

type View = "list" | "tree";

type SortKey = "count" | "tag";

export default function TagsSettingsPage() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "count", dir: "desc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action | null>(null);
  const [target, setTarget] = useState("");
  // Dry-run result, tagged with the request it answers so a stale one is ignored.
  const [checked, setChecked] = useState<{ key: string; preview: Preview | null; error: string }>({ key: "", preview: null, error: "" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [status, setStatus] = useState("");
  const [view, setView] = useState<View>("list");
  const [variantsOnly, setVariantsOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, error: loadErr, mutate } = useSWR<TagsResponse>("/api/tags?business=all&tree=1", jsonFetcher, {
    revalidateOnFocus: false,
  });
  const loadError = loadErr ? "Couldn't load tags." : "";

  const rows = useMemo(() => {
    const list = (data?.tags ?? []).filter(
      (t) =>
        (!variantsOnly || t.hasVariants) &&
        (!query.trim() || t.spellings.some((s) => containsNormalized(s.spelling, query))),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) =>
      sort.key === "count"
        ? (a.count - b.count) * dir || a.tag.localeCompare(b.tag)
        : a.tag.localeCompare(b.tag) * dir,
    );
  }, [data, query, sort, variantsOnly]);

  const variantTags = useMemo(() => (data?.tags ?? []).filter((t) => t.hasVariants), [data]);

  // Tree view: children by parent, roots sorted by count. With a search the
  // matching nodes are listed flat with their full path.
  const treeRows = useMemo(() => {
    const nodes = data?.tree ?? [];
    const byCount = (a: TreeNode, b: TreeNode) => b.count - a.count || a.path.localeCompare(b.path);
    if (query.trim()) return nodes.filter((n) => containsNormalized(n.path, query)).sort(byCount).map((n) => ({ node: n, depth: 0, flat: true }));
    const children = new Map<string | null, TreeNode[]>();
    for (const n of nodes) children.set(n.parentKey, [...(children.get(n.parentKey) ?? []), n]);
    const out: Array<{ node: TreeNode; depth: number; flat: boolean }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const n of (children.get(parent) ?? []).sort(byCount)) {
        out.push({ node: n, depth, flat: false });
        if (expanded.has(n.key)) walk(n.key, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [data, query, expanded]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectedRows = useMemo(() => (data?.tags ?? []).filter((t) => selected.has(t.key)), [data, selected]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "count" ? "desc" : "asc" }));
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function open(a: Action) {
    setAction(a);
    setActionError("");
    setStatus("");
    setTarget(
      a.kind === "rename" ? a.tag.tag : a.kind === "merge" ? a.tags[0]?.tag ?? "" : a.kind === "prefix" ? a.node.path : "",
    );
  }

  // The request body for the open action (or null while the form is incomplete).
  const body = useMemo(() => {
    if (!action) return null;
    if (action.kind === "delete") return { op: "delete", tags: action.tags.map((t) => t.tag) };
    if (action.kind === "normalize") return { op: "normalize", tags: action.tags.map((t) => t.tag) };
    if (!target.trim() || target.includes(",")) return null;
    if (action.kind === "prefix") return { op: "rename_prefix", prefix: action.node.path, newPrefix: target.trim() };
    if (action.kind === "rename") return { op: "rename", tag: action.tag.tag, newName: target.trim() };
    return { op: "merge", tags: action.tags.map((t) => t.tag), into: target.trim() };
  }, [action, target]);

  // Ask the server what the change would touch whenever the form changes.
  const bodyKey = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!bodyKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...JSON.parse(bodyKey), dryRun: true }),
      }).catch(() => null);
      const json = res ? await res.json().catch(() => null) : null;
      if (cancelled) return;
      setChecked(
        res?.ok
          ? { key: bodyKey, preview: json as Preview, error: "" }
          : { key: bodyKey, preview: null, error: json?.error ?? "Couldn't check this change." },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bodyKey]);
  const preview = bodyKey && checked.key === bodyKey ? checked.preview : null;
  const previewing = !!bodyKey && checked.key !== bodyKey;
  const previewError = bodyKey && checked.key === bodyKey ? checked.error : "";

  async function confirm() {
    if (!body) return;
    setBusy(true);
    setActionError("");
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setActionError(json?.error ?? "The change failed.");
        return;
      }
      setStatus(`Updated ${json?.changed ?? 0} transaction(s).`);
      setAction(null);
      setSelected(new Set());
      if (action?.kind === "normalize") setVariantsOnly(false);
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  const currency = data?.currency ?? "USD";
  const canConfirm = !!body && !!preview && preview.affected > 0 && !preview.tooLarge && !preview.truncated && !previewing && !busy;
  const isMergeOnRename = action?.kind === "rename" && preview?.targetExists;

  const sortIcon = (key: SortKey) =>
    sort.key === key ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null;
  const splitCell = (n: { businessCount: number; personalCount: number }) => (
    <>
      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">{n.businessCount || "—"}</td>
      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">{n.personalCount || "—"}</td>
    </>
  );
  const variantsBadge = (t: TagRow) =>
    t.hasVariants ? (
      <Badge
        variant="outline"
        className="ml-2 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300"
        title={t.spellings.map((s) => `"${s.spelling}" × ${s.count}`).join(", ")}
      >
        {t.spellings.length} spellings
      </Badge>
    ) : null;
  const tagActions = (t: TagRow) => (
    <>
      {t.hasVariants && (
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => open({ kind: "normalize", tags: [t] })}>
          Normalize
        </Button>
      )}
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => open({ kind: "rename", tag: t })}>
        Rename
      </Button>
      <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => open({ kind: "delete", tags: [t] })}>
        Delete
      </Button>
    </>
  );
  const treeLabel = (r: { node: TreeNode; depth: number; flat: boolean }) => (
    <div className="flex items-center gap-1 min-w-0" style={{ paddingLeft: r.flat ? 0 : r.depth * 16 }}>
      {!r.flat && r.node.childCount > 0 ? (
        <button
          type="button"
          className="text-muted-foreground"
          aria-label={expanded.has(r.node.key) ? `Collapse ${r.node.path}` : `Expand ${r.node.path}`}
          onClick={() => toggleExpanded(r.node.key)}
        >
          {expanded.has(r.node.key) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      {r.node.isTag ? (
        <Link href={buildTxDrillUrl({ tag: r.node.path })} className="font-medium hover:underline truncate">
          {r.flat ? r.node.path : r.node.name}
        </Link>
      ) : (
        <span className="font-medium truncate">{r.flat ? r.node.path : r.node.name}</span>
      )}
      {r.node.childCount > 0 && (
        <span className="text-xs text-muted-foreground shrink-0">
          · {r.node.tagCount} tags
        </span>
      )}
    </div>
  );
  const treeAction = (n: TreeNode) => (
    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => open({ kind: "prefix", node: n })}>
      {n.childCount > 0 ? "Rename branch" : "Rename"}
    </Button>
  );
  const isEmpty = view === "list" ? rows.length === 0 : treeRows.length === 0;

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tags</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Rename, merge or remove the tags on your transactions</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your tags</CardTitle>
          <CardDescription>
            Tags that differ only in letter case or spacing count as one tag. A tag marked
            &ldquo;spellings&rdquo; is stored in more than one way; normalize it to keep the most used one.
            Tags with &ldquo;/&rdquo; (like &ldquo;colleague/Smith&rdquo;) form a tree.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search tags…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="View">
              {(["list", "tree"] as const).map((v) => (
                <Button
                  key={v}
                  variant={view === v ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 text-xs"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                >
                  {v === "list" ? "List" : "Tree"}
                </Button>
              ))}
            </div>
            {view === "list" && (
              <>
                <Button
                  variant={variantsOnly ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={variantsOnly}
                  disabled={variantTags.length === 0 && !variantsOnly}
                  onClick={() => setVariantsOnly((v) => !v)}
                >
                  Multiple spellings{variantTags.length ? ` (${variantTags.length})` : ""}
                </Button>
                {variantsOnly && variantTags.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => open({ kind: "normalize", tags: variantTags })}>
                    Normalize all
                  </Button>
                )}
                <Button variant="outline" size="sm" disabled={selectedRows.length < 2} onClick={() => open({ kind: "merge", tags: selectedRows })}>
                  Merge selected{selectedRows.length >= 2 ? ` (${selectedRows.length})` : ""}
                </Button>
                <Button variant="outline" size="sm" disabled={selectedRows.length === 0} onClick={() => open({ kind: "delete", tags: selectedRows })}>
                  Delete selected
                </Button>
              </>
            )}
          </div>

          {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {data?.truncated && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              You have more tagged transactions than this page reads at once; counts may be incomplete.
            </p>
          )}
          {view === "tree" && (
            <p className="text-xs text-muted-foreground">
              A branch counts each transaction once, even when it carries several tags of that branch.
            </p>
          )}

          {!data && !loadError ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : isEmpty ? (
            <p className="text-sm text-muted-foreground">
              {query || variantsOnly ? "No tags match." : "No tags yet."}
            </p>
          ) : view === "list" ? (
            <>
              {/* Phones: one card per tag */}
              <ul className="space-y-2 sm:hidden">
                {rows.map((t) => (
                  <li key={t.key} className="rounded-lg border p-3 text-sm">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={`Select ${t.tag}`}
                        checked={selected.has(t.key)}
                        onChange={() => toggle(t.key)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center">
                          <Link href={buildTxDrillUrl({ tag: t.tag })} className="font-medium hover:underline break-all">
                            {t.tag}
                          </Link>
                          {variantsBadge(t)}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                          {t.count} tx · business {t.businessCount} · personal {t.personalCount}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {formatCurrency(t.total, currency)} · {t.firstDate ?? "—"} → {t.lastDate ?? "—"}
                        </p>
                      </div>
                    </div>
                    <div className="flex justify-end gap-1 mt-2">{tagActions(t)}</div>
                  </li>
                ))}
              </ul>
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="w-8 py-2" />
                      <th className="py-2 pr-2">
                        <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("tag")}>
                          Tag {sortIcon("tag")}
                        </button>
                      </th>
                      <th className="py-2 pr-2 text-right">
                        <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("count")}>
                          Transactions {sortIcon("count")}
                        </button>
                      </th>
                      <th className="py-2 pr-2 text-right">Business</th>
                      <th className="py-2 pr-2 text-right">Personal</th>
                      <th className="py-2 pr-2 text-right">Total ({currency})</th>
                      <th className="py-2 pr-2">First</th>
                      <th className="py-2 pr-2">Last</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.key} className="border-b last:border-0">
                        <td className="py-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${t.tag}`}
                            checked={selected.has(t.key)}
                            onChange={() => toggle(t.key)}
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <Link href={buildTxDrillUrl({ tag: t.tag })} className="font-medium hover:underline">
                            {t.tag}
                          </Link>
                          {variantsBadge(t)}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{t.count}</td>
                        {splitCell(t)}
                        <td className="py-2 pr-2 text-right tabular-nums">{formatCurrency(t.total, currency)}</td>
                        <td className="py-2 pr-2 tabular-nums text-muted-foreground">{t.firstDate ?? "—"}</td>
                        <td className="py-2 pr-2 tabular-nums text-muted-foreground">{t.lastDate ?? "—"}</td>
                        <td className="py-2 text-right whitespace-nowrap">{tagActions(t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              <ul className="space-y-2 sm:hidden">
                {treeRows.map((r) => (
                  <li key={r.node.key} className="rounded-lg border p-3 text-sm">
                    {treeLabel(r)}
                    <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                      {r.node.count} tx · business {r.node.businessCount} · personal {r.node.personalCount} ·{" "}
                      {formatCurrency(r.node.total, currency)}
                    </p>
                    <div className="flex justify-end mt-1">{treeAction(r.node)}</div>
                  </li>
                ))}
              </ul>
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-2 pr-2">Tag</th>
                      <th className="py-2 pr-2 text-right">Transactions</th>
                      <th className="py-2 pr-2 text-right">Business</th>
                      <th className="py-2 pr-2 text-right">Personal</th>
                      <th className="py-2 pr-2 text-right">Total ({currency})</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {treeRows.map((r) => (
                      <tr key={r.node.key} className="border-b last:border-0">
                        <td className="py-2 pr-2">{treeLabel(r)}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{r.node.count}</td>
                        {splitCell(r.node)}
                        <td className="py-2 pr-2 text-right tabular-nums">{formatCurrency(r.node.total, currency)}</td>
                        <td className="py-2 text-right whitespace-nowrap">{treeAction(r.node)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={action != null} onOpenChange={(o) => { if (!o && !busy) setAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "rename"
                ? "Rename tag"
                : action?.kind === "merge"
                  ? "Merge tags"
                  : action?.kind === "prefix"
                    ? action.node.childCount > 0 ? "Rename branch" : "Rename tag"
                    : action?.kind === "normalize"
                      ? "Normalize spelling"
                      : "Delete tag"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {action?.kind === "delete" && (
              <p>
                Remove {action.tags.map((t) => `"${t.tag}"`).join(", ")} from every transaction that has{" "}
                {action.tags.length > 1 ? "them" : "it"}. The transactions themselves stay.
              </p>
            )}
            {action?.kind === "merge" && (
              <p>Every transaction tagged {action.tags.map((t) => `"${t.tag}"`).join(", ")} will carry one tag instead:</p>
            )}
            {action?.kind === "rename" && <p>Rename &ldquo;{action.tag.tag}&rdquo; on every transaction to:</p>}
            {action?.kind === "prefix" && (
              <p>
                Rename &ldquo;{action.node.path}&rdquo;
                {action.node.childCount > 0 ? <> and every tag under it (&ldquo;{action.node.path}/…&rdquo;)</> : null} to:
              </p>
            )}
            {action?.kind === "normalize" && (
              <p>Every spelling of {action.tags.length === 1 ? "this tag" : "these tags"} becomes the most used one.</p>
            )}
            {action && (action.kind === "rename" || action.kind === "merge" || action.kind === "prefix") && (
              <Input
                autoFocus
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder={action.kind === "prefix" ? "New name" : "New tag name"}
                list="tag-names"
              />
            )}
            <datalist id="tag-names">
              {(data?.tags ?? []).map((t) => (
                <option key={t.key} value={t.tag} />
              ))}
            </datalist>
            {target.includes(",") && <p className="text-destructive">A tag name can&apos;t contain a comma.</p>}

            {previewing && <p className="text-muted-foreground">Checking…</p>}
            {preview && !previewing && (
              <div className="rounded-md border p-3 space-y-1">
                <p>
                  <span className="font-medium">{preview.affected}</span> transaction(s) will change
                  {preview.tagCount != null && (
                    <>
                      {" "}across <span className="font-medium">{preview.tagCount}</span> tag(s)
                    </>
                  )}
                  .
                </p>
                {isMergeOnRename && (
                  <p className="text-amber-700 dark:text-amber-300">
                    &ldquo;{target.trim()}&rdquo; already exists on {preview.targetCount} transaction(s), so this merges the two tags.
                  </p>
                )}
                {action?.kind === "merge" && preview.targetExists && (
                  <p className="text-muted-foreground">
                    &ldquo;{target.trim()}&rdquo; already exists on {preview.targetCount} transaction(s); they keep it.
                  </p>
                )}
                {preview.collisions && preview.collisions.length > 0 && (
                  <p className="text-amber-700 dark:text-amber-300">
                    {preview.collisions.length} renamed tag(s) already exist and will merge: {preview.collisions.slice(0, 5).join(", ")}
                    {preview.collisions.length > 5 ? "…" : ""}
                  </p>
                )}
                {preview.tags && preview.tags.length > 0 && (
                  <ul className="text-muted-foreground list-disc pl-5">
                    {preview.tags.slice(0, 8).map((t) => (
                      <li key={t.tag}>
                        {t.variants.map((v) => `"${v}"`).join(", ")} → &ldquo;{t.tag}&rdquo;
                      </li>
                    ))}
                    {preview.tags.length > 8 && <li>and {preview.tags.length - 8} more</li>}
                  </ul>
                )}
                {(preview.tooLarge || preview.truncated) && (
                  <p className="text-destructive">This touches too many transactions for one change (limit 10,000).</p>
                )}
                {preview.affected === 0 && <p className="text-muted-foreground">Nothing to change.</p>}
              </div>
            )}
            {(actionError || previewError) && <p className="text-destructive">{actionError || previewError}</p>}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
              Cancel
            </Button>
            <Button variant={action?.kind === "delete" ? "destructive" : "default"} disabled={!canConfirm} onClick={confirm}>
              {busy
                ? "Saving…"
                : action?.kind === "delete"
                  ? "Remove tag"
                  : action?.kind === "normalize"
                    ? "Normalize"
                    : isMergeOnRename || action?.kind === "merge"
                      ? "Merge"
                      : "Rename"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
