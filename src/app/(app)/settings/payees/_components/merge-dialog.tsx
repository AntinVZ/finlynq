"use client";

/**
 * "Merge into one payee": pick the target — a new directory entry (name +
 * merchant type) or an existing one (searchable picker) — and preview what
 * changes before confirming. Used for clusters, selected payees and "Add to
 * directory".
 *
 * P6.1: the merchant type (group → position) is the main type field; the old
 * entity type sits under "Додатково" and follows the merchant type unless
 * picked by hand («Особи і ФОП» → person; a person-looking name stays a person).
 */

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PAYEE_TYPES, type PayeeType } from "@/lib/payees/match-key";
import { payeeTypeForMerchantType } from "@/lib/payees/payee-type";
import { OpDialog, type OpPreview } from "./op-dialog";
import { PAYEE_TYPE_OPTIONS, typeLabel } from "./payee-ui";
import { EntityPicker, type EntityOption } from "./entity-picker";
import { MerchantTypeSelect, merchantTypeLabel, type MerchantTypeOption, type MerchantTypeRef } from "./merchant-type-ui";
import { useStudioT } from "./i18n";

export type { EntityOption } from "./entity-picker";

const asPayeeType = (t: string): PayeeType => ((PAYEE_TYPES as readonly string[]).includes(t) ? (t as PayeeType) : "other");

export function MergeDialog({
  title,
  payees,
  entityIds = [],
  suggestedName,
  suggestedType,
  entities,
  merchantTypes = [],
  typeHint,
  clusterKeys,
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
  /** The entity-type guess for the payees (retail / person / …). */
  suggestedType: string;
  entities: EntityOption[];
  merchantTypes?: readonly MerchantTypeOption[];
  /** A merchant-type suggestion; applied only when the user clicks it. */
  typeHint?: (MerchantTypeRef & { reason: string }) | null;
  /** Matching keys of the payees being merged (orders the picker). */
  clusterKeys?: string[];
  warning?: string | null;
  onClose: () => void;
  onDone: (r: OpPreview) => void;
}) {
  const t = useStudioT();
  const [mode, setMode] = useState<"new" | "existing">(entityIds.length === 1 && payees.length > 0 ? "existing" : "new");
  const [name, setName] = useState(suggestedName);
  const [merchantType, setMerchantType] = useState<MerchantTypeRef | null>(null);
  /** "" = follow the merchant type. */
  const [manualType, setManualType] = useState("");
  const [targetId, setTargetId] = useState<number | null>(entityIds[0] ?? null);

  const autoType = payeeTypeForMerchantType(merchantType?.group, asPayeeType(suggestedType));
  const type = manualType || autoType;
  const hint = typeHint && !(merchantType && merchantTypeLabel(merchantType) === merchantTypeLabel(typeHint)) ? typeHint : null;

  const body =
    mode === "new"
      ? name.trim()
        ? { op: "merge", into: { name: name.trim(), type, ...(merchantType ? { merchantType } : {}) }, entityIds, payees }
        : null
      : targetId
        ? { op: "merge", into: { entityId: targetId }, entityIds: entityIds.filter((id) => id !== targetId), payees }
        : null;

  return (
    <OpDialog title={title} body={body} onClose={onClose} onDone={onDone} confirmLabel={t("merge.confirm")}>
      {warning && <p className="text-xs rounded-md border border-rose-300 p-2 text-rose-700 dark:border-rose-800 dark:text-rose-300">{warning}</p>}
      <p className="text-xs text-muted-foreground break-words">
        {payees.length > 0 && <>{t("merge.spellings", { list: payees.map((p) => `“${p}”`).join(", ") })} </>}
        {entityIds.length > 0 && <>{t("merge.entries", { n: entityIds.length })}</>}
      </p>
      <div className="flex gap-3 text-sm" role="radiogroup" aria-label={t("merge.target")}>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> {t("merge.new")}
        </label>
        <label className={`inline-flex items-center gap-1.5 ${entities.length ? "" : "opacity-50"}`}>
          <input type="radio" disabled={!entities.length} checked={mode === "existing"} onChange={() => setMode("existing")} /> {t("picker.label")}
        </label>
      </div>
      {mode === "new" ? (
        <div className="space-y-2">
          <Input aria-label={t("common.canonicalName")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("common.canonicalName")} />
          <MerchantTypeSelect types={merchantTypes} value={merchantType} onChange={setMerchantType} className="h-9 w-full rounded-md border bg-background px-2 text-sm" />
          {hint && (
            <Button
              size="sm"
              variant="outline"
              className="h-auto min-h-7 max-w-full whitespace-normal break-words text-left text-xs"
              title={t("common.hintTitle", { reason: hint.reason })}
              onClick={() => setMerchantType({ group: hint.group, name: hint.name })}
            >
              {t("common.hint")}: {merchantTypeLabel(hint)}
            </Button>
          )}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {t("common.moreEntryType", { type: typeLabel(type, t) })}
              {manualType ? "" : ` ${t("merge.auto")}`}
            </summary>
            <label className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t("common.entryType")}</span>
              <select aria-label={t("common.type")} className="h-8 rounded-md border bg-background px-2 text-sm" value={manualType} onChange={(e) => setManualType(e.target.value)}>
                <option value="">{t("merge.autoOption", { type: typeLabel(autoType, t) })}</option>
                {PAYEE_TYPE_OPTIONS.map((x) => (
                  <option key={x} value={x}>
                    {typeLabel(x, t)}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-muted-foreground">{t("merge.personsNote")}</p>
          </details>
        </div>
      ) : (
        <EntityPicker entities={entities} value={targetId} onChange={setTargetId} clusterKeys={clusterKeys} />
      )}
    </OpDialog>
  );
}
