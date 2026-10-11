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
import { ArrowDown, ArrowUp, Search } from "lucide-react";
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
  total: number;
};

type TagsResponse = { tags: TagRow[]; currency: string; truncated: boolean };

type Action =
  | { kind: "rename"; tag: TagRow }
  | { kind: "merge"; tags: TagRow[] }
  | { kind: "delete"; tags: TagRow[] };

type Preview = {
  affected: number;
  targetExists: boolean;
  targetCount: number;
  tooLarge: boolean;
  truncated: boolean;
};

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

  const { data, error: loadErr, mutate } = useSWR<TagsResponse>("/api/tags?business=all", jsonFetcher, {
    revalidateOnFocus: false,
  });
  const loadError = loadErr ? "Couldn't load tags." : "";

  const rows = useMemo(() => {
    const list = (data?.tags ?? []).filter(
      (t) => !query.trim() || t.spellings.some((s) => containsNormalized(s.spelling, query)),
    );
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) =>
      sort.key === "count"
        ? (a.count - b.count) * dir || a.tag.localeCompare(b.tag)
        : a.tag.localeCompare(b.tag) * dir,
    );
  }, [data, query, sort]);

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
    setTarget(a.kind === "rename" ? a.tag.tag : a.kind === "merge" ? a.tags[0]?.tag ?? "" : "");
  }

  // The request body for the open action (or null while the form is incomplete).
  const body = useMemo(() => {
    if (!action) return null;
    if (action.kind === "delete") return { op: "delete", tags: action.tags.map((t) => t.tag) };
    if (!target.trim() || target.includes(",")) return null;
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
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  const currency = data?.currency ?? "USD";
  const canConfirm = !!body && !!preview && preview.affected > 0 && !preview.tooLarge && !preview.truncated && !previewing && !busy;
  const isMergeOnRename = action?.kind === "rename" && preview?.targetExists;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tags</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Rename, merge or remove the tags on your transactions</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your tags</CardTitle>
          <CardDescription>
            Tags that differ only in letter case or spacing count as one tag. A tag marked
            &ldquo;spellings&rdquo; is stored in more than one way; rename it to keep one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search tags…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Button variant="outline" size="sm" disabled={selectedRows.length < 2} onClick={() => open({ kind: "merge", tags: selectedRows })}>
              Merge selected{selectedRows.length >= 2 ? ` (${selectedRows.length})` : ""}
            </Button>
            <Button variant="outline" size="sm" disabled={selectedRows.length === 0} onClick={() => open({ kind: "delete", tags: selectedRows })}>
              Delete selected
            </Button>
          </div>

          {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
          {loadError && <p className="text-sm text-destructive">{loadError}</p>}
          {data?.truncated && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              You have more tagged transactions than this page reads at once; counts may be incomplete.
            </p>
          )}

          {!data && !loadError ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{query ? "No tags match." : "No tags yet."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="w-8 py-2" />
                    <th className="py-2 pr-2">
                      <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("tag")}>
                        Tag {sort.key === "tag" && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </button>
                    </th>
                    <th className="py-2 pr-2 text-right">
                      <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("count")}>
                        Transactions {sort.key === "count" && (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </button>
                    </th>
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
                        {t.hasVariants && (
                          <Badge
                            variant="outline"
                            className="ml-2 border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300"
                            title={t.spellings.map((s) => `"${s.spelling}" × ${s.count}`).join(", ")}
                          >
                            {t.spellings.length} spellings
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{t.count}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatCurrency(t.total, currency)}</td>
                      <td className="py-2 pr-2 tabular-nums text-muted-foreground">{t.firstDate ?? "—"}</td>
                      <td className="py-2 pr-2 tabular-nums text-muted-foreground">{t.lastDate ?? "—"}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => open({ kind: "rename", tag: t })}>
                          Rename
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => open({ kind: "delete", tags: [t] })}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={action != null} onOpenChange={(o) => { if (!o && !busy) setAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action?.kind === "rename" ? "Rename tag" : action?.kind === "merge" ? "Merge tags" : "Delete tag"}
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
            {action && action.kind !== "delete" && (
              <Input
                autoFocus
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="New tag name"
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
                  <span className="font-medium">{preview.affected}</span> transaction(s) will change.
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
