"use client";

/**
 * Merchant types in Payee Studio (P6, B26): one drop-down with the groups as
 * <optgroup>s, the bulk "Призначити тип" dialog (selected entries or every
 * entry with a type word) and the dictionary editor. Every change goes
 * through OpDialog: preview first, then one undoable batch.
 */

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { OpDialog, type OpPreview } from "./op-dialog";
import { typeLabel } from "./payee-ui";
import { useStudioT, type StudioT } from "./i18n";
import { localizeMerchantType } from "@/lib/payees/merchant-types";

export type MerchantTypeOption = { id: number | null; group: string; name: string; sort?: number; defaultCategoryId?: number | null; code?: string | null };
export type MerchantTypeRef = { group: string; name: string; code?: string | null };

const SEP = "\u0001";
const keyOf = (t: MerchantTypeRef) => `${t.group}${SEP}${t.name}`;
const refOf = (key: string): MerchantTypeRef | null => {
  if (!key) return null;
  const [group, name] = key.split(SEP);
  return { group, name };
};

/** A type as the interface shows it: built-in names in the interface language (P8), the user's own as written. */
export function localizedType(t: MerchantTypeRef, tr?: StudioT): { group: string; name: string } {
  return tr ? localizeMerchantType(t, tr as (key: string) => string) : { group: t.group, name: t.name };
}

/** "Група → Позиція", or just the group when it is its own only position. */
export function merchantTypeLabel(t: MerchantTypeRef | null | undefined, tr?: StudioT): string {
  if (!t) return "";
  const single = t.group.toLowerCase() === t.name.toLowerCase();
  const l = localizedType(t, tr);
  return single ? l.group : `${l.group} → ${l.name}`;
}

/**
 * P6.1: the type shown next to a payee in lists — its merchant type, or, when
 * it has none yet, the old entity type, dimmed.
 */
export function PayeeTypeLabel({ merchantType, type, className = "" }: { merchantType?: MerchantTypeRef | null; type?: string | null; className?: string }) {
  const t = useStudioT();
  if (merchantType) return <span className={className}>{merchantTypeLabel(merchantType, t)}</span>;
  if (!type) return null;
  return (
    <span className={`${className} opacity-60`} title={t("types.notAssigned")}>
      {typeLabel(type, t)}
    </span>
  );
}

/** The groups in display order, each with its positions. */
export function groupMerchantTypes(types: readonly MerchantTypeOption[]): Array<{ group: string; items: MerchantTypeOption[] }> {
  const out: Array<{ group: string; items: MerchantTypeOption[] }> = [];
  for (const t of types) {
    let g = out.find((x) => x.group === t.group);
    if (!g) out.push((g = { group: t.group, items: [] }));
    g.items.push(t);
  }
  return out;
}

/** One select: groups as optgroups; a one-position group is a plain option. */
export function MerchantTypeSelect({
  types,
  value,
  onChange,
  label,
  emptyLabel,
  className = "h-9 rounded-md border bg-background px-2 text-sm",
}: {
  types: readonly MerchantTypeOption[];
  value: MerchantTypeRef | null;
  onChange: (v: MerchantTypeRef | null) => void;
  label?: string;
  emptyLabel?: string;
  className?: string;
}) {
  const t = useStudioT();
  return (
    <select aria-label={label ?? t("types.merchantType")} className={className} value={value ? keyOf(value) : ""} onChange={(e) => onChange(refOf(e.target.value))}>
      <option value="">{emptyLabel ?? t("types.none")}</option>
      {groupMerchantTypes(types).map((g) =>
        g.items.length === 1 && g.items[0].name === g.group ? (
          <option key={g.group} value={keyOf(g.items[0])}>
            {localizedType(g.items[0], t).group}
          </option>
        ) : (
          <optgroup key={g.group} label={localizedType(g.items[0], t).group}>
            {g.items.map((x) => (
              <option key={keyOf(x)} value={keyOf(x)}>
                {localizedType(x, t).name}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </select>
  );
}

/** Bulk assignment: the selected entries, or every entry with a type word. */
export function SetMerchantTypeDialog({
  types,
  entityIds,
  onClose,
  onDone,
}: {
  types: readonly MerchantTypeOption[];
  /** Selected directory entries (may be empty → by type word). */
  entityIds: number[];
  onClose: () => void;
  onDone: (r: OpPreview) => void;
}) {
  const t = useStudioT();
  const [mode, setMode] = useState<"selected" | "word">(entityIds.length ? "selected" : "word");
  const [value, setValue] = useState<MerchantTypeRef | null>(null);
  const [word, setWord] = useState("");
  const [onlyUntyped, setOnlyUntyped] = useState(true);
  const body =
    mode === "selected"
      ? entityIds.length
        ? { op: "set_merchant_type", merchantType: value, entityIds, onlyUntyped }
        : null
      : word.trim()
        ? { op: "set_merchant_type", merchantType: value, typeWord: word.trim(), onlyUntyped }
        : null;
  return (
    <OpDialog title={t("types.setTitle")} body={body} onClose={onClose} onDone={onDone} confirmLabel={t("types.setConfirm")}>
      <div className="flex flex-wrap gap-3 text-sm" role="radiogroup" aria-label={t("types.setTarget")}>
        <label className={`inline-flex items-center gap-1.5 ${entityIds.length ? "" : "opacity-50"}`}>
          <input type="radio" disabled={!entityIds.length} checked={mode === "selected"} onChange={() => setMode("selected")} /> {t("types.setSelected", { n: entityIds.length })}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" checked={mode === "word"} onChange={() => setMode("word")} /> {t("types.setByWord")}
        </label>
      </div>
      {mode === "word" && (
        <Input aria-label={t("types.word")} placeholder={t("types.wordPlaceholder")} value={word} onChange={(e) => setWord(e.target.value)} />
      )}
      <MerchantTypeSelect types={types} value={value} onChange={setValue} emptyLabel={t("types.clear")} className="h-9 w-full rounded-md border bg-background px-2 text-sm" />
      <label className="inline-flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={onlyUntyped} onChange={(e) => setOnlyUntyped(e.target.checked)} /> {t("types.onlyUntyped")}
      </label>
    </OpDialog>
  );
}

/** The dictionary editor: add a position (new or existing group), rename, remove. */
export function MerchantTypesEditor({
  types,
  onClose,
  onDone,
}: {
  types: readonly MerchantTypeOption[];
  onClose: () => void;
  onDone: (r: OpPreview) => void;
}) {
  const t = useStudioT();
  const [change, setChange] = useState<{ title: string; body: Record<string, unknown> } | null>(null);
  const [group, setGroup] = useState("");
  const [name, setName] = useState("");
  const [rename, setRename] = useState<{ id: number; group: string; name: string } | null>(null);
  const virtual = types.some((t) => t.id == null);
  if (change) {
    return (
      <OpDialog title={change.title} body={change.body} onClose={() => setChange(null)} onDone={onDone} confirmLabel={t("common.save")} />
    );
  }
  return (
    <OpDialog title={t("types.editorTitle")} body={null} onClose={onClose} onDone={onDone}>
      <p className="text-xs text-muted-foreground">
        {t("types.editorIntro")} {virtual ? t("types.editorStarter") : ""}
      </p>
      <ul className="max-h-72 overflow-y-auto divide-y rounded-md border text-sm">
        {groupMerchantTypes(types).map((g) => (
          <li key={g.group} className="p-2">
            <p className="font-medium">{localizedType(g.items[0], t).group}</p>
            <ul className="mt-1 space-y-1">
              {g.items.map((x) => (
                <li key={`${x.group}:${x.name}`} className="flex flex-wrap items-center gap-2 text-xs">
                  {rename && rename.id === x.id ? (
                    <>
                      <Input aria-label={t("types.group")} className="h-7 w-40 text-xs" value={rename.group} onChange={(e) => setRename({ ...rename, group: e.target.value })} />
                      <Input aria-label={t("types.position")} className="h-7 w-40 text-xs" value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} />
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!rename.group.trim()}
                        onClick={() => setChange({ title: t("types.renameTitle", { name: merchantTypeLabel(x, t) }), body: { op: "merchant_types", update: [{ id: x.id, group: rename.group.trim(), name: rename.name.trim() || rename.group.trim() }] } })}
                      >
                        {t("types.check")}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setRename(null)}>
                        {t("common.cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 break-all" title={x.name}>{localizedType(x, t).name}</span>
                      {x.id != null && (
                        <>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setRename({ id: x.id!, group: x.group, name: x.name })}>
                            {t("types.rename")}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setChange({ title: t("types.removeTitle", { name: merchantTypeLabel(x, t) }), body: { op: "merchant_types", remove: [x.id] } })}>
                            {t("types.remove")}
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input aria-label={t("types.newGroup")} placeholder={t("types.group")} value={group} onChange={(e) => setGroup(e.target.value)} list="merchant-type-groups" />
        <datalist id="merchant-type-groups">
          {groupMerchantTypes(types).map((g) => (
            <option key={g.group} value={g.group} />
          ))}
        </datalist>
        <Input aria-label={t("types.newPosition")} placeholder={t("types.positionOptional")} value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          size="sm"
          disabled={!group.trim()}
          onClick={() => setChange({ title: t("types.addTitle"), body: { op: "merchant_types", add: [{ group: group.trim(), ...(name.trim() ? { name: name.trim() } : {}) }] } })}
        >
          {t("types.add")}
        </Button>
      </div>
    </OpDialog>
  );
}
