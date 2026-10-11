"use client";

/**
 * Preview → confirm dialog for every Payee Studio change.
 *
 * On open it POSTs the op to /api/payees with `dryRun: true` (the server runs
 * it in a rolled-back transaction) and shows exactly what will change: rows
 * per table, the spellings that are renamed, conflicts and warnings. Confirm
 * sends the same op without `dryRun`; the change becomes one batch that can
 * be undone for 30 days.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type OpPreview = {
  op: string;
  batchId: number | null;
  entity: { id: number; name: string; type: string } | null;
  created: boolean;
  aliasesAdded: Array<{ pattern: string; mode: string }>;
  aliasesRemoved: number;
  identifiersAdded: Array<{ kind: string; masked: string }>;
  identifiersRemoved: number;
  entitiesRemoved: number;
  rows: {
    total: number;
    byTable: { transactions: number; recurring: number; staged: number };
    changes: Array<{ from: string; to: string; count: number }>;
    conflicts: Array<{ payee: string; entities: string[]; count: number }>;
    truncated: boolean;
  };
  undo?: { restoredRows: number; skippedRows: number; restoredEntities: number; removedEntities: number };
  warnings: string[];
  blocked: string | null;
};

const TABLE_LABEL = { transactions: "transactions", recurring: "recurring transactions", staged: "staged imports" } as const;

/** "will change 12 rows: 10 transactions, 1 recurring transaction, 1 staged import" */
export function describeRows(p: OpPreview): string {
  const parts = (Object.keys(TABLE_LABEL) as Array<keyof typeof TABLE_LABEL>)
    .filter((t) => p.rows.byTable[t] > 0)
    .map((t) => `${p.rows.byTable[t]} in ${TABLE_LABEL[t]}`);
  if (p.rows.total === 0) return "No stored payees change.";
  return `Renames ${p.rows.total} row${p.rows.total === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}

export async function postPayeeOp(
  body: Record<string, unknown>,
  endpoint = "/api/payees",
): Promise<{ ok: boolean; data: OpPreview | null; error: string }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  const json = res ? await res.json().catch(() => null) : null;
  if (!res?.ok) return { ok: false, data: null, error: json?.error ?? "The change failed." };
  return { ok: true, data: json as OpPreview, error: "" };
}

export function OpDialog({
  title,
  body,
  onClose,
  onDone,
  children,
  confirmLabel = "Confirm",
  endpoint = "/api/payees",
}: {
  title: string;
  /** The op request; null while the form inside is incomplete. */
  body: Record<string, unknown> | null;
  onClose: () => void;
  onDone: (result: OpPreview) => void;
  children?: React.ReactNode;
  confirmLabel?: string;
  /** POST target; the proposals page approves through /api/payees/proposals. */
  endpoint?: string;
}) {
  const key = body ? JSON.stringify(body) : "";
  const [checked, setChecked] = useState<{ key: string; preview: OpPreview | null; error: string }>({ key: "", preview: null, error: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const r = await postPayeeOp({ ...JSON.parse(key), dryRun: true }, endpoint);
      if (!cancelled) setChecked({ key, preview: r.data, error: r.error });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, endpoint]);

  const preview = key && checked.key === key ? checked.preview : null;
  const previewError = key && checked.key === key ? checked.error : "";
  const previewing = !!key && checked.key !== key;

  async function confirm() {
    if (!body) return;
    setBusy(true);
    setError("");
    const r = await postPayeeOp(body, endpoint);
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error);
      return;
    }
    onDone(r.data);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {children}
          {previewing && <p className="text-muted-foreground">Checking what this changes…</p>}
          {previewError && <p className="text-destructive">{previewError}</p>}
          {preview && (
            <div className="rounded-md border p-3 space-y-2" aria-live="polite">
              {preview.undo ? (
                <p>
                  Restores {preview.undo.restoredRows} row(s)
                  {preview.undo.removedEntities ? `, removes ${preview.undo.removedEntities} payee(s)` : ""}
                  {preview.undo.restoredEntities ? `, restores ${preview.undo.restoredEntities} payee(s)` : ""}.
                </p>
              ) : (
                <p className="font-medium">{describeRows(preview)}</p>
              )}
              {preview.aliasesAdded.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Adds {preview.aliasesAdded.length} alias(es): {preview.aliasesAdded.map((a) => `“${a.pattern}”${a.mode !== "exact" ? ` (${a.mode})` : ""}`).join(", ")}
                </p>
              )}
              {preview.entitiesRemoved > 0 && !preview.undo && (
                <p className="text-xs text-muted-foreground">Removes {preview.entitiesRemoved} payee(s) from the directory.</p>
              )}
              {preview.rows.changes.length > 0 && (
                <ul className="text-xs max-h-40 overflow-y-auto space-y-0.5">
                  {preview.rows.changes.map((c) => (
                    <li key={`${c.from}→${c.to}`} className="break-all">
                      “{c.from}” → “{c.to}” <span className="text-muted-foreground">× {c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.rows.conflicts.length > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Left alone (match several payees): {preview.rows.conflicts.map((c) => `“${c.payee}”`).join(", ")}
                </p>
              )}
              {preview.warnings.map((w) => (
                <p key={w} className="text-xs text-amber-600 dark:text-amber-400">{w}</p>
              ))}
              {preview.blocked && <p className="text-xs text-destructive">{preview.blocked}</p>}
              <p className="text-xs text-muted-foreground">Bank statement rows are never changed. You can undo this for 30 days.</p>
            </div>
          )}
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={!preview || !!preview.blocked || previewing || busy}>
              {busy ? "Saving…" : confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
