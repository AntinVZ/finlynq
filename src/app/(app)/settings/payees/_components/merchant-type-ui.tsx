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

export type MerchantTypeOption = { id: number | null; group: string; name: string; sort?: number; defaultCategoryId?: number | null };
export type MerchantTypeRef = { group: string; name: string };

const SEP = "\u0001";
const keyOf = (t: MerchantTypeRef) => `${t.group}${SEP}${t.name}`;
const refOf = (key: string): MerchantTypeRef | null => {
  if (!key) return null;
  const [group, name] = key.split(SEP);
  return { group, name };
};

/** "Група → Позиція", or just the group when it is its own only position. */
export function merchantTypeLabel(t: MerchantTypeRef | null | undefined): string {
  if (!t) return "";
  return t.group.toLowerCase() === t.name.toLowerCase() ? t.group : `${t.group} → ${t.name}`;
}

/**
 * P6.1: the type shown next to a payee in lists — its merchant type, or, when
 * it has none yet, the old entity type, dimmed.
 */
export function PayeeTypeLabel({ merchantType, type, className = "" }: { merchantType?: MerchantTypeRef | null; type?: string | null; className?: string }) {
  if (merchantType) return <span className={className}>{merchantTypeLabel(merchantType)}</span>;
  if (!type) return null;
  return (
    <span className={`${className} opacity-60`} title="Тип мерчанта ще не призначено">
      {typeLabel(type)}
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
  label = "Тип мерчанта",
  emptyLabel = "— без типу —",
  className = "h-9 rounded-md border bg-background px-2 text-sm",
}: {
  types: readonly MerchantTypeOption[];
  value: MerchantTypeRef | null;
  onChange: (v: MerchantTypeRef | null) => void;
  label?: string;
  emptyLabel?: string;
  className?: string;
}) {
  return (
    <select aria-label={label} className={className} value={value ? keyOf(value) : ""} onChange={(e) => onChange(refOf(e.target.value))}>
      <option value="">{emptyLabel}</option>
      {groupMerchantTypes(types).map((g) =>
        g.items.length === 1 && g.items[0].name === g.group ? (
          <option key={g.group} value={keyOf(g.items[0])}>
            {g.group}
          </option>
        ) : (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((t) => (
              <option key={keyOf(t)} value={keyOf(t)}>
                {t.name}
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
    <OpDialog title="Призначити тип мерчанта" body={body} onClose={onClose} onDone={onDone} confirmLabel="Призначити">
      <div className="flex flex-wrap gap-3 text-sm" role="radiogroup" aria-label="Кому">
        <label className={`inline-flex items-center gap-1.5 ${entityIds.length ? "" : "opacity-50"}`}>
          <input type="radio" disabled={!entityIds.length} checked={mode === "selected"} onChange={() => setMode("selected")} /> Вибраним ({entityIds.length})
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" checked={mode === "word"} onChange={() => setMode("word")} /> За словом-типом
        </label>
      </div>
      {mode === "word" && (
        <Input aria-label="Слово-тип" placeholder="ресторан, аптека, АЗС…" value={word} onChange={(e) => setWord(e.target.value)} />
      )}
      <MerchantTypeSelect types={types} value={value} onChange={setValue} emptyLabel="— прибрати тип —" className="h-9 w-full rounded-md border bg-background px-2 text-sm" />
      <label className="inline-flex items-center gap-1.5 text-xs">
        <input type="checkbox" checked={onlyUntyped} onChange={(e) => setOnlyUntyped(e.target.checked)} /> Лише записи без типу
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
  const [change, setChange] = useState<{ title: string; body: Record<string, unknown> } | null>(null);
  const [group, setGroup] = useState("");
  const [name, setName] = useState("");
  const [rename, setRename] = useState<{ id: number; group: string; name: string } | null>(null);
  const virtual = types.some((t) => t.id == null);
  if (change) {
    return (
      <OpDialog title={change.title} body={change.body} onClose={() => setChange(null)} onDone={onDone} confirmLabel="Зберегти" />
    );
  }
  return (
    <OpDialog title="Типи мерчантів" body={null} onClose={onClose} onDone={onDone}>
      <p className="text-xs text-muted-foreground">
        Один тип на мерчанта: група → позиція. Зв&apos;язок із категоріями необов&apos;язковий. {virtual ? "Це стартовий набір; він збережеться під час першої зміни." : ""}
      </p>
      <ul className="max-h-72 overflow-y-auto divide-y rounded-md border text-sm">
        {groupMerchantTypes(types).map((g) => (
          <li key={g.group} className="p-2">
            <p className="font-medium">{g.group}</p>
            <ul className="mt-1 space-y-1">
              {g.items.map((t) => (
                <li key={`${t.group}:${t.name}`} className="flex flex-wrap items-center gap-2 text-xs">
                  {rename && rename.id === t.id ? (
                    <>
                      <Input aria-label="Група" className="h-7 w-40 text-xs" value={rename.group} onChange={(e) => setRename({ ...rename, group: e.target.value })} />
                      <Input aria-label="Позиція" className="h-7 w-40 text-xs" value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} />
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!rename.group.trim()}
                        onClick={() => setChange({ title: `Перейменувати «${merchantTypeLabel(t)}»`, body: { op: "merchant_types", update: [{ id: t.id, group: rename.group.trim(), name: rename.name.trim() || rename.group.trim() }] } })}
                      >
                        Перевірити
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setRename(null)}>
                        Скасувати
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 break-all">{t.name}</span>
                      {t.id != null && (
                        <>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setRename({ id: t.id!, group: t.group, name: t.name })}>
                            Перейменувати
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setChange({ title: `Видалити «${merchantTypeLabel(t)}»`, body: { op: "merchant_types", remove: [t.id] } })}>
                            Видалити
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
        <Input aria-label="Група нового типу" placeholder="Група" value={group} onChange={(e) => setGroup(e.target.value)} list="merchant-type-groups" />
        <datalist id="merchant-type-groups">
          {groupMerchantTypes(types).map((g) => (
            <option key={g.group} value={g.group} />
          ))}
        </datalist>
        <Input aria-label="Позиція нового типу" placeholder="Позиція (необов'язково)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          size="sm"
          disabled={!group.trim()}
          onClick={() => setChange({ title: "Додати тип", body: { op: "merchant_types", add: [{ group: group.trim(), ...(name.trim() ? { name: name.trim() } : {}) }] } })}
        >
          Додати
        </Button>
      </div>
    </OpDialog>
  );
}
