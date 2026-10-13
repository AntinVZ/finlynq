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
import type { StudioT } from "@/lib/payees/i18n";
import { useStudioT } from "./i18n";

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
    changes: Array<{ from: string; to: string; count: number; caseOnly?: boolean }>;
    conflicts: Array<{ payee: string; entities: string[]; count: number }>;
    truncated: boolean;
  };
  undo?: { restoredRows: number; skippedRows: number; restoredEntities: number; removedEntities: number };
  warnings: string[];
  blocked: string | null;
  /** Why an apply renames nothing (P6). */
  emptyReason?: string | null;
  /** P6: entries whose merchant type changes, and dictionary changes. */
  typed?: Array<{ id: number; name: string; from: string | null; to: string | null; via?: string }>;
  /** P6.2: entries a type word reached but left alone (alias-only match, mixed hints). */
  skipped?: Array<{ id: number; name: string; reason: string }>;
  merchantTypes?: { added: string[]; updated: string[]; removed: string[] };
  /** P6.2: own accounts / cards changed (masked descriptions). */
  ownAccounts?: { added: string[]; updated: string[]; removed: string[] };
  /** P6.2: bulk registry fill — entries created, rows a later Apply renames. */
  bulk?: { created: number; createdIds: number[]; pendingRows: number; entities: Array<{ rowId: string; name: string; aliases: number; merchantType: string | null }> };
};

const TABLE_LABEL = { transactions: "op.inTransactions", recurring: "op.inRecurring", staged: "op.inStaged" } as const;

/** "Renames 12 rows: 10 in transactions, 1 in recurring transactions, 1 in staged imports." */
export function describeRows(p: OpPreview, t: StudioT): string {
  const parts = (Object.keys(TABLE_LABEL) as Array<keyof typeof TABLE_LABEL>)
    .filter((k) => p.rows.byTable[k] > 0)
    .map((k) => t(TABLE_LABEL[k], { n: p.rows.byTable[k] }));
  if (p.rows.total === 0) return t("op.noRows");
  return t("op.renames", { n: p.rows.total, parts: parts.join(", ") });
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
  // An empty error means the server gave none; OpDialog shows its own text then.
  if (!res?.ok) return { ok: false, data: null, error: json?.error ?? "" };
  return { ok: true, data: json as OpPreview, error: "" };
}

export function OpDialog({
  title,
  body,
  onClose,
  onDone,
  children,
  confirmLabel,
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
  const t = useStudioT();
  const key = body ? JSON.stringify(body) : "";
  const [checked, setChecked] = useState<{ key: string; preview: OpPreview | null; error: string }>({ key: "", preview: null, error: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const r = await postPayeeOp({ ...JSON.parse(key), dryRun: true }, endpoint);
      if (!cancelled) setChecked({ key, preview: r.data, error: r.ok ? "" : r.error || t("op.failed") });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, endpoint, t]);

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
      setError(r.error || t("op.failed"));
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
          {previewing && <p className="text-muted-foreground">{t("op.checking")}</p>}
          {previewError && <p className="text-destructive">{previewError}</p>}
          {preview && (
            <div className="rounded-md border p-3 space-y-2" aria-live="polite">
              {preview.undo ? (
                <p>
                  {t("op.undoRestoresRows", { n: preview.undo.restoredRows })}
                  {preview.undo.removedEntities ? t("op.undoRemovesPayees", { n: preview.undo.removedEntities }) : ""}
                  {preview.undo.restoredEntities ? t("op.undoRestoresPayees", { n: preview.undo.restoredEntities }) : ""}.
                </p>
              ) : preview.bulk ? (
                <p className="font-medium">{t("bulk.previewSummary", { n: preview.bulk.created, aliases: preview.aliasesAdded.length, rows: preview.bulk.pendingRows })}</p>
              ) : (
                <p className="font-medium">{describeRows(preview, t)}</p>
              )}
              {preview.aliasesAdded.length > 0 && !preview.bulk && (
                <p className="text-xs text-muted-foreground">
                  {t("op.addsAliases", { n: preview.aliasesAdded.length, list: preview.aliasesAdded.map((a) => `“${a.pattern}”${a.mode !== "exact" ? ` (${a.mode})` : ""}`).join(", ") })}
                </p>
              )}
              {preview.entitiesRemoved > 0 && !preview.undo && (
                <p className="text-xs text-muted-foreground">{t("op.removesPayees", { n: preview.entitiesRemoved })}</p>
              )}
              {preview.rows.changes.length > 0 && (
                <ul className="text-xs max-h-40 overflow-y-auto space-y-0.5">
                  {preview.rows.changes.map((c) => (
                    <li key={`${c.from}→${c.to}`} className="break-all">
                      “{c.from}” → “{c.to}” <span className="text-muted-foreground">× {c.count}</span>
                      {c.caseOnly && <span className="ms-1 text-muted-foreground">{t("op.caseOnly")}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {(preview.typed ?? []).length > 0 && (
                <div className="text-xs space-y-0.5">
                  <p className="font-medium">{t("op.typed", { n: preview.typed!.length })}</p>
                  <ul className="max-h-40 overflow-y-auto">
                    {preview.typed!.map((x) => (
                      <li key={`${x.id}:${x.name}`} className="break-all">
                        {x.name}: {x.from ?? t("op.noType")} → {x.to ?? t("op.noType")}
                        {x.via && <span className="text-muted-foreground"> · {t("op.via", { via: x.via })}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(preview.skipped ?? []).length > 0 && (
                <div className="text-xs space-y-0.5">
                  <p className="font-medium text-amber-600 dark:text-amber-400">{t("op.skipped", { n: preview.skipped!.length })}</p>
                  <ul className="max-h-32 overflow-y-auto text-muted-foreground">
                    {preview.skipped!.map((x) => (
                      <li key={`s${x.id}`} className="break-all">
                        {x.name}: {x.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.merchantTypes && preview.merchantTypes.added.length > 0 && <p className="text-xs text-muted-foreground">{t("op.typesAdded", { list: preview.merchantTypes.added.join(", ") })}</p>}
              {preview.merchantTypes && preview.merchantTypes.updated.length > 0 && <p className="text-xs text-muted-foreground">{t("op.typesUpdated", { list: preview.merchantTypes.updated.join(", ") })}</p>}
              {preview.merchantTypes && preview.merchantTypes.removed.length > 0 && <p className="text-xs text-muted-foreground">{t("op.typesRemoved", { list: preview.merchantTypes.removed.join(", ") })}</p>}
              {preview.ownAccounts && preview.ownAccounts.added.length > 0 && <p className="text-xs">{t("own.added", { list: preview.ownAccounts.added.join("; ") })}</p>}
              {preview.ownAccounts && preview.ownAccounts.updated.length > 0 && <p className="text-xs">{t("own.updated", { list: preview.ownAccounts.updated.join("; ") })}</p>}
              {preview.ownAccounts && preview.ownAccounts.removed.length > 0 && <p className="text-xs">{t("own.removed", { list: preview.ownAccounts.removed.join("; ") })}</p>}
              {preview.rows.conflicts.length > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {t("op.conflicts", { list: preview.rows.conflicts.map((c) => `“${c.payee}”`).join(", ") })}
                </p>
              )}
              {preview.warnings.map((w) => (
                <p key={w} className="text-xs text-amber-600 dark:text-amber-400">{w}</p>
              ))}
              {preview.emptyReason && <p className="text-xs text-amber-600 dark:text-amber-400">{preview.emptyReason}</p>}
              {preview.blocked && <p className="text-xs text-destructive">{preview.blocked}</p>}
              <p className="text-xs text-muted-foreground">{t("op.footer")}</p>
            </div>
          )}
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={confirm} disabled={!preview || !!preview.blocked || previewing || busy}>
              {busy ? t("common.saving") : (confirmLabel ?? t("common.confirm"))}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
