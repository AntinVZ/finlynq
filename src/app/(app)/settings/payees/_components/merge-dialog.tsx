"use client";

/**
 * "Merge into one payee": pick the target — a new directory entry (name +
 * type) or an existing one — and preview what changes before confirming.
 * Used for clusters, selected payees and "Add to directory".
 */

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { OpDialog, type OpPreview } from "./op-dialog";
import { PAYEE_TYPE_OPTIONS, typeLabel } from "./payee-ui";

export type EntityOption = { id: number; name: string; type: string };

export function MergeDialog({
  title,
  payees,
  entityIds = [],
  suggestedName,
  suggestedType,
  entities,
  warning,
  onClose,
  onDone,
}: {
  title: string;
  /** Spellings that become aliases of the target. */
  payees: string[];
  /** Directory entries folded into the target. */
  entityIds?: number[];
  suggestedName: string;
  suggestedType: string;
  entities: EntityOption[];
  warning?: string | null;
  onClose: () => void;
  onDone: (r: OpPreview) => void;
}) {
  const [mode, setMode] = useState<"new" | "existing">(entityIds.length === 1 && payees.length > 0 ? "existing" : "new");
  const [name, setName] = useState(suggestedName);
  const [type, setType] = useState(suggestedType);
  const [targetId, setTargetId] = useState<number | null>(entityIds[0] ?? entities[0]?.id ?? null);

  const body =
    mode === "new"
      ? name.trim()
        ? { op: "merge", into: { name: name.trim(), type }, entityIds, payees }
        : null
      : targetId
        ? { op: "merge", into: { entityId: targetId }, entityIds: entityIds.filter((id) => id !== targetId), payees }
        : null;

  return (
    <OpDialog title={title} body={body} onClose={onClose} onDone={onDone} confirmLabel="Merge">
      {warning && <p className="text-xs rounded-md border border-rose-300 p-2 text-rose-700 dark:border-rose-800 dark:text-rose-300">{warning}</p>}
      <p className="text-xs text-muted-foreground break-words">
        {payees.length > 0 && <>Spellings: {payees.map((p) => `“${p}”`).join(", ")}. </>}
        {entityIds.length > 0 && <>Directory entries: {entityIds.length}.</>}
      </p>
      <div className="flex gap-3 text-sm" role="radiogroup" aria-label="Merge target">
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> New payee
        </label>
        <label className={`inline-flex items-center gap-1.5 ${entities.length ? "" : "opacity-50"}`}>
          <input type="radio" disabled={!entities.length} checked={mode === "existing"} onChange={() => setMode("existing")} /> Existing payee
        </label>
      </div>
      {mode === "new" ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input aria-label="Canonical name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Canonical name" />
          <select aria-label="Type" className="h-9 rounded-md border bg-background px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
            {PAYEE_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <select
          aria-label="Existing payee"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={targetId ?? ""}
          onChange={(e) => setTargetId(Number(e.target.value) || null)}
        >
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({typeLabel(e.type)})
            </option>
          ))}
        </select>
      )}
    </OpDialog>
  );
}
