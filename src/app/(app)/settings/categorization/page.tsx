"use client";

/**
 * /settings/categorization — Category Management ONLY.
 *
 * FINLYNQ-84 (2026-05-21) moved Transaction Rules out of this page into the
 * dedicated `/settings/rules` sub-page. The legacy single-field rule UI
 * (matchField/matchType/matchValue + assignCategoryId/assignTags/renameTo)
 * is gone — the new editor supports multi-condition rules + 7 action kinds.
 * See `pf-app/src/app/(app)/settings/rules/page.tsx` and
 * `pf-app/docs/transaction-rules-v2.md`.
 *
 * Categories are two-level: group → category (a group is just the
 * `categories.group` label). The page is split into Expense / Income /
 * Reconciliation tabs; every category row has a visible "⋯" menu with
 * Edit, Move to group, Merge into… and Delete, and every group header can be
 * renamed (which relabels all of the group's categories).
 *
 *   - GET  /api/categories?withCounts=1  — categories + `txCount`
 *   - PUT  /api/categories               — name / group / type / note
 *     (type only while the category has no transactions — 409 otherwise)
 *   - POST /api/categories/groups        — rename a group
 *   - POST /api/categories/merge         — dryRun preview, then merge
 *   - DELETE /api/categories?id=         — refused while anything uses it
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tag, Plus, AlertTriangle, MoreHorizontal, Pencil, FolderInput, GitMerge, Trash2 } from "lucide-react";

type CategoryType = "E" | "I" | "R";
type Category = { id: number; type: string; group: string; name: string; note: string; txCount?: number };

const TYPE_LABEL: Record<CategoryType, string> = { E: "Expense", I: "Income", R: "Reconciliation" };
const TYPES: CategoryType[] = ["E", "I", "R"];

type MergePreview = {
  totalDependents: number;
  dependents: Record<string, number>;
  budgetConflicts: number;
  typeMismatch: boolean;
};

type Dialogs =
  | { kind: "edit"; cat: Category }
  | { kind: "move"; cat: Category }
  | { kind: "merge"; cat: Category }
  | { kind: "delete"; cat: Category }
  | { kind: "group"; group: string };

const DEPENDENT_LABELS: Record<string, string> = {
  transactions: "transactions",
  splits: "splits",
  subscriptions: "subscriptions",
  budgets: "budgets",
  budgetTemplates: "budget templates",
  recurringTransactions: "recurring transactions",
  emailRules: "email import rules",
  rules: "rules",
};

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  const json = res ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
  return { ok: !!res?.ok, json };
}

function errorOf(json: Record<string, unknown> | null, fallback: string): string {
  const e = json?.error ?? json?.message;
  return typeof e === "string" && e ? e : fallback;
}

export default function CategorizationSettingsPage() {
  const { data, error: loadErr, mutate } = useSWR<Category[]>("/api/categories?withCounts=1", jsonFetcher, {
    revalidateOnFocus: false,
  });
  const categories = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const [tab, setTab] = useState<CategoryType>("E");
  const [status, setStatus] = useState("");
  const [catError, setCatError] = useState("");

  // Add form
  const [newCatForm, setNewCatForm] = useState({ name: "", type: "E", group: "" });
  const [newCatErrors, setNewCatErrors] = useState<{ name?: string; group?: string }>({});
  const [showAddCat, setShowAddCat] = useState(false);

  // Dialog state
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [form, setForm] = useState({ name: "", group: "", type: "E", note: "" });
  const [mergeTarget, setMergeTarget] = useState<string>("");
  const [mergePreview, setMergePreview] = useState<{ target: string; preview: MergePreview | null; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");

  const uniqueGroups = useMemo(
    () => Array.from(new Set(categories.map((c) => c.group).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [categories],
  );

  const countsByType = useMemo(() => {
    const out: Record<CategoryType, number> = { E: 0, I: 0, R: 0 };
    for (const c of categories) if (c.type in out) out[c.type as CategoryType] += 1;
    return out;
  }, [categories]);

  const grouped = useMemo(() => {
    const map = new Map<string, Category[]>();
    for (const c of categories) {
      if (c.type !== tab) continue;
      const g = c.group ?? "";
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return Array.from(map.entries()).sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [categories, tab]);

  function openDialog(d: Dialogs) {
    setDialog(d);
    setDialogError("");
    setStatus("");
    setMergeTarget("");
    setMergePreview(null);
    if (d.kind === "edit" || d.kind === "move") {
      setForm({ name: d.cat.name, group: d.cat.group ?? "", type: d.cat.type, note: d.cat.note ?? "" });
    } else if (d.kind === "group") {
      setForm({ name: "", group: d.group, type: "E", note: "" });
    }
  }

  function closeDialog() {
    if (!busy) setDialog(null);
  }

  async function run(fn: () => Promise<string | null>) {
    setBusy(true);
    setDialogError("");
    try {
      const err = await fn();
      if (err) {
        setDialogError(err);
        return;
      }
      setDialog(null);
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  // ── actions ────────────────────────────────────────────────────────────────
  function saveEdit(cat: Category) {
    return run(async () => {
      const name = form.name.trim();
      const group = form.group.trim();
      if (!name) return "Name is required";
      if (!group) return "Group is required";
      const body: Record<string, unknown> = { id: cat.id };
      if (name !== cat.name) body.name = name;
      if (group !== (cat.group ?? "")) body.group = group;
      if (form.type !== cat.type) body.type = form.type;
      if (form.note !== (cat.note ?? "")) body.note = form.note;
      if (Object.keys(body).length === 1) return null;
      const { ok, json } = await send("/api/categories", "PUT", body);
      if (!ok) return errorOf(json, "Failed to update category");
      setStatus(`Saved "${name}".`);
      if (body.type && body.type !== tab) setTab(body.type as CategoryType);
      return null;
    });
  }

  function saveMove(cat: Category) {
    return run(async () => {
      const group = form.group.trim();
      if (!group) return "Group is required";
      if (group === (cat.group ?? "")) return null;
      const { ok, json } = await send("/api/categories", "PUT", { id: cat.id, group });
      if (!ok) return errorOf(json, "Failed to move category");
      setStatus(`Moved "${cat.name}" to ${group}.`);
      return null;
    });
  }

  function saveGroupRename(from: string) {
    return run(async () => {
      const to = form.group.trim();
      if (!to) return "New group name is required";
      if (to === from) return null;
      const { ok, json } = await send("/api/categories/groups", "POST", { from, to });
      if (!ok) return errorOf(json, "Failed to rename group");
      setStatus(`Renamed group to ${to} (${Number(json?.updated ?? 0)} categories).`);
      return null;
    });
  }

  async function pickMergeTarget(cat: Category, target: string) {
    setMergeTarget(target);
    setDialogError("");
    if (!target) {
      setMergePreview(null);
      return;
    }
    setMergePreview({ target, preview: null, error: "" });
    const { ok, json } = await send("/api/categories/merge", "POST", {
      sourceId: cat.id,
      targetId: Number(target),
      dryRun: true,
    });
    setMergePreview((cur) =>
      cur?.target !== target
        ? cur
        : ok
          ? { target, preview: json as unknown as MergePreview, error: "" }
          : { target, preview: null, error: errorOf(json, "Couldn't check this merge.") },
    );
  }

  function confirmMerge(cat: Category) {
    return run(async () => {
      if (!mergeTarget) return "Pick a category to merge into";
      const { ok, json } = await send("/api/categories/merge", "POST", { sourceId: cat.id, targetId: Number(mergeTarget) });
      if (!ok) return errorOf(json, "Failed to merge categories");
      const into = categories.find((c) => c.id === Number(mergeTarget))?.name ?? "the target";
      setStatus(`Merged "${cat.name}" into "${into}".`);
      return null;
    });
  }

  function confirmDelete(cat: Category) {
    return run(async () => {
      const { ok, json } = await send(`/api/categories?id=${cat.id}`, "DELETE");
      if (!ok) return errorOf(json, "Failed to delete category");
      setStatus(`Deleted "${cat.name}".`);
      return null;
    });
  }

  async function handleAddCategory(e: React.FormEvent) {
    e.preventDefault();
    const errs: { name?: string; group?: string } = {};
    if (!newCatForm.name.trim()) errs.name = "Name is required";
    if (!newCatForm.group.trim()) errs.group = "Group is required";
    setNewCatErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setCatError("");
    const { ok, json } = await send("/api/categories", "POST", {
      name: newCatForm.name.trim(),
      type: newCatForm.type,
      group: newCatForm.group.trim(),
    });
    if (!ok) {
      setCatError(errorOf(json, "Failed to create category"));
      return;
    }
    setTab(newCatForm.type as CategoryType);
    setNewCatForm({ name: "", type: "E", group: "" });
    setNewCatErrors({});
    setShowAddCat(false);
    await mutate();
  }

  // ── render helpers ─────────────────────────────────────────────────────────
  const groupDatalist = (
    <datalist id="cat-groups">
      {uniqueGroups.map((g) => <option key={g} value={g} />)}
    </datalist>
  );

  const dialogCat = dialog && dialog.kind !== "group" ? dialog.cat : null;
  const typeLocked = !!dialogCat && (dialogCat.txCount ?? 0) > 0;
  const mergeCandidates = dialogCat
    ? categories
        .filter((c) => c.id !== dialogCat.id && c.type === dialogCat.type)
        .sort((a, b) => (a.group || "").localeCompare(b.group || "") || a.name.localeCompare(b.name))
    : [];
  const groupFrom = dialog?.kind === "group" ? dialog.group : "";
  const groupMembers = dialog?.kind === "group" ? categories.filter((c) => (c.group ?? "") === groupFrom).length : 0;
  const groupTarget = form.group.trim();
  const groupTargetMembers =
    dialog?.kind === "group" && groupTarget && groupTarget !== groupFrom
      ? categories.filter((c) => c.group === groupTarget).length
      : 0;
  const preview = mergePreview?.target === mergeTarget ? mergePreview.preview : null;
  const previewing = !!mergeTarget && mergePreview?.target === mergeTarget && !mergePreview.preview && !mergePreview.error;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Categorization</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage transaction categories. Auto-categorization rules live in <a href="/settings/rules" className="underline hover:text-foreground">Rules</a>.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                <Tag className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Category Management</CardTitle>
                <CardDescription>Categories are grouped; use the ⋯ menu to edit, move, merge or delete one</CardDescription>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAddCat(!showAddCat)}>
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {(catError || loadErr) && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {catError || "Failed to load categories"}
            </div>
          )}
          {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}

          {/* Add category form */}
          {showAddCat && (
            <form onSubmit={handleAddCategory} className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <Label>Name</Label>
                  <Input value={newCatForm.name} onChange={(e) => { setNewCatForm({ ...newCatForm, name: e.target.value }); setNewCatErrors({ ...newCatErrors, name: "" }); }} placeholder="Category name" />
                  {newCatErrors.name && <p className="text-xs text-destructive mt-1">{newCatErrors.name}</p>}
                </div>
                <div>
                  <Label>Group</Label>
                  <Input
                    value={newCatForm.group}
                    onChange={(e) => { setNewCatForm({ ...newCatForm, group: e.target.value }); setNewCatErrors({ ...newCatErrors, group: "" }); }}
                    placeholder="e.g. Housing"
                    list="cat-groups"
                  />
                  {newCatErrors.group && <p className="text-xs text-destructive mt-1">{newCatErrors.group}</p>}
                </div>
                <div>
                  <Label>Type</Label>
                  <Select value={newCatForm.type} onValueChange={(v) => setNewCatForm({ ...newCatForm, type: v ?? "E" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TYPES.map((t) => <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">Add Category</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setShowAddCat(false); setNewCatErrors({}); }}>Cancel</Button>
              </div>
            </form>
          )}
          {groupDatalist}

          <Tabs value={tab} onValueChange={(v) => setTab(v as CategoryType)}>
            <TabsList>
              {TYPES.map((t) => (
                <TabsTrigger key={t} value={t}>
                  {TYPE_LABEL[t]} <span className="ml-1 text-xs text-muted-foreground tabular-nums">{countsByType[t]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* Category list grouped */}
          {grouped.map(([group, cats]) => (
            <div key={group || "__ungrouped"}>
              <div className="flex items-center justify-between mb-1">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{group || "Ungrouped"}</h4>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() => openDialog({ kind: "group", group })}
                  aria-label={`Rename group ${group || "Ungrouped"}`}
                >
                  <Pencil className="h-3 w-3 mr-1" /> Rename group
                </Button>
              </div>
              <div className="space-y-1">
                {cats.map((cat) => (
                  <div key={cat.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm truncate">{cat.name}</span>
                        <Badge variant="secondary" className="text-[10px] tabular-nums" title="Transactions in this category">
                          {cat.txCount ?? 0} tx
                        </Badge>
                      </div>
                      {cat.note && <p className="text-xs text-muted-foreground truncate">{cat.note}</p>}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`Actions for ${cat.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="min-w-44">
                        <DropdownMenuItem onClick={() => openDialog({ kind: "edit", cat })}>
                          <Pencil className="h-4 w-4 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openDialog({ kind: "move", cat })}>
                          <FolderInput className="h-4 w-4 mr-2" /> Move to group
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openDialog({ kind: "merge", cat })}>
                          <GitMerge className="h-4 w-4 mr-2" /> Merge into…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onClick={() => openDialog({ kind: "delete", cat })}>
                          <Trash2 className="h-4 w-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {!data && !loadErr && <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>}
          {data && grouped.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No {TYPE_LABEL[tab].toLowerCase()} categories</p>
          )}
        </CardContent>
      </Card>

      {/* Edit / Move / Merge / Rename group */}
      <Dialog open={!!dialog && dialog.kind !== "delete"} onOpenChange={(o) => { if (!o) closeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "edit"
                ? "Edit category"
                : dialog?.kind === "move"
                  ? "Move to group"
                  : dialog?.kind === "merge"
                    ? "Merge category"
                    : "Rename group"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            {dialog?.kind === "edit" && (
              <>
                <div>
                  <Label>Name</Label>
                  <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <Label>Group</Label>
                  <Input value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} list="cat-groups" />
                </div>
                <div>
                  <Label>Type</Label>
                  <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v ?? form.type })} disabled={typeLocked}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TYPES.map((t) => <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {typeLocked && (
                    <p className="text-xs text-muted-foreground mt-1">
                      The type can only change while no transactions use this category ({dialog.cat.txCount} do). Merge it into a category of the other type instead.
                    </p>
                  )}
                </div>
                <div>
                  <Label>Note</Label>
                  <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional" />
                </div>
              </>
            )}

            {dialog?.kind === "move" && (
              <>
                <p>Move &ldquo;{dialog.cat.name}&rdquo; to:</p>
                <Input autoFocus value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} list="cat-groups" placeholder="Group name" />
                {form.group.trim() && !uniqueGroups.includes(form.group.trim()) && (
                  <p className="text-xs text-muted-foreground">This creates a new group.</p>
                )}
              </>
            )}

            {dialog?.kind === "group" && (
              <>
                <p>
                  Rename &ldquo;{groupFrom || "Ungrouped"}&rdquo; — this changes the group of{" "}
                  <span className="font-medium">{groupMembers}</span> categor{groupMembers === 1 ? "y" : "ies"}.
                </p>
                <Input autoFocus value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} list="cat-groups" placeholder="New group name" />
                {groupTargetMembers > 0 && (
                  <p className="text-amber-700 dark:text-amber-300">
                    &ldquo;{groupTarget}&rdquo; already has {groupTargetMembers} categor{groupTargetMembers === 1 ? "y" : "ies"}, so the two groups become one.
                  </p>
                )}
              </>
            )}

            {dialog?.kind === "merge" && (
              <>
                <p>
                  Move everything in &ldquo;{dialog.cat.name}&rdquo; into another {TYPE_LABEL[dialog.cat.type as CategoryType]?.toLowerCase() ?? ""} category, then delete &ldquo;{dialog.cat.name}&rdquo;.
                </p>
                {mergeCandidates.length === 0 ? (
                  <p className="text-muted-foreground">There is no other category of this type to merge into.</p>
                ) : (
                  <Select value={mergeTarget} onValueChange={(v) => pickMergeTarget(dialog.cat, v ?? "")}>
                    <SelectTrigger><SelectValue placeholder="Merge into…" /></SelectTrigger>
                    <SelectContent>
                      {mergeCandidates.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.group ? `${c.group} › ` : ""}{c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {previewing && <p className="text-muted-foreground">Checking…</p>}
                {preview && (
                  <div className="rounded-md border p-3 space-y-1">
                    {preview.totalDependents === 0 ? (
                      <p>Nothing uses this category; it will just be deleted.</p>
                    ) : (
                      <p>
                        Moves{" "}
                        {Object.entries(preview.dependents)
                          .filter(([, n]) => n > 0)
                          .map(([k, n]) => `${n} ${DEPENDENT_LABELS[k] ?? k}`)
                          .join(", ")}
                        .
                      </p>
                    )}
                    {preview.budgetConflicts > 0 && (
                      <p className="text-destructive">
                        Both categories have a budget in {preview.budgetConflicts} of the same month{preview.budgetConflicts === 1 ? "" : "s"}. Remove one of each pair in Budgets first.
                      </p>
                    )}
                  </div>
                )}
                {mergePreview?.target === mergeTarget && mergePreview.error && (
                  <p className="text-destructive">{mergePreview.error}</p>
                )}
              </>
            )}

            {dialogError && <p className="text-destructive">{dialogError}</p>}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" disabled={busy} onClick={closeDialog}>Cancel</Button>
            {dialog?.kind === "edit" && <Button disabled={busy} onClick={() => saveEdit(dialog.cat)}>{busy ? "Saving…" : "Save"}</Button>}
            {dialog?.kind === "move" && <Button disabled={busy} onClick={() => saveMove(dialog.cat)}>{busy ? "Saving…" : "Move"}</Button>}
            {dialog?.kind === "group" && (
              <Button disabled={busy || !groupTarget || groupTarget === groupFrom} onClick={() => saveGroupRename(groupFrom)}>
                {busy ? "Saving…" : groupTargetMembers > 0 ? "Merge groups" : "Rename"}
              </Button>
            )}
            {dialog?.kind === "merge" && (
              <Button
                variant="destructive"
                disabled={busy || !preview || preview.budgetConflicts > 0}
                onClick={() => confirmMerge(dialog.cat)}
              >
                {busy ? "Merging…" : "Merge"}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => { if (!o) closeDialog(); }}
        title="Delete category"
        description={
          dialog?.kind === "delete" ? (
            <div className="space-y-2">
              <p>Delete &ldquo;{dialog.cat.name}&rdquo;?</p>
              {(dialog.cat.txCount ?? 0) > 0 && (
                <p>
                  {dialog.cat.txCount} transaction(s) use it, so the delete will be refused. Use &ldquo;Merge into…&rdquo; to move them to another category first.
                </p>
              )}
              {dialogError && <p className="text-destructive">{dialogError}</p>}
            </div>
          ) : null
        }
        busy={busy}
        onConfirm={() => { if (dialog?.kind === "delete") void confirmDelete(dialog.cat); }}
      />
    </div>
  );
}
