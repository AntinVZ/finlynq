"use client";

/**
 * «Готово · Скасувати» (P8 stage 3): after a confirmed change the batch can
 * be undone from a toast for 10 seconds (and from Changes for 30 days).
 * Undo runs `op: "undo"` on the batch right away — it reverses exactly what
 * the person just confirmed in the preview.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { ActionButton } from "@/components/actions/action-button";
import { useT } from "@/lib/i18n/client";

export const UNDO_TOAST_MS = 10_000;

type Toast = { id: number; batchId: number; message: string };

export function useUndoToast(onUndone: (restoredRows: number) => void | Promise<void>) {
  const [toast, setToast] = useState<Toast | null>(null);
  const seq = useRef(0);
  const show = useCallback((batchId: number | null | undefined, message: string) => {
    if (!batchId) return;
    seq.current += 1;
    setToast({ id: seq.current, batchId, message });
  }, []);
  const node = toast ? <UndoToast key={toast.id} toast={toast} onClose={() => setToast(null)} onUndone={onUndone} /> : null;
  return { show, node };
}

function UndoToast({ toast, onClose, onUndone }: { toast: Toast; onClose: () => void; onUndone: (restoredRows: number) => void | Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (busy || error) return;
    const h = setTimeout(onClose, UNDO_TOAST_MS);
    return () => clearTimeout(h);
  }, [busy, error, onClose]);

  async function undo() {
    setBusy(true);
    const res = await fetch("/api/payees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "undo", batchId: toast.batchId }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    if (!res?.ok) {
      setError(json?.error || t("toast.undoFailed"));
      return;
    }
    onClose();
    await onUndone(Number(json?.undo?.restoredRows ?? 0));
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-20 z-50 mx-auto flex max-w-md flex-wrap items-center gap-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg md:bottom-6"
    >
      <CheckCircle2 className="h-4 w-4 shrink-0 text-action-confirm-text" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{t("toast.done")}</span>
        {toast.message ? <span className="text-muted-foreground"> · {toast.message}</span> : null}
        {error && <span className="block text-destructive">{error}</span>}
      </span>
      <ActionButton intent="reject" soft size="sm" disabled={busy} onClick={() => void undo()}>
        {t("toast.undo")}
      </ActionButton>
    </div>
  );
}
