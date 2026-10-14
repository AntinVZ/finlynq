"use client";

/**
 * Searchable picker for a directory entry (P6.1, "Existing payee" in the
 * merge dialog). An input with an always-visible list under it, so it works
 * inside a dialog and on touch screens without a floating popup.
 *
 * Search: case and apostrophes ignored, name and aliases, then Latin /
 * Cyrillic matching keys (lib/payees/entity-search.ts). Without text, the
 * entries alike to the payees being merged come first, then the rest by rows.
 * Keyboard: ↑ / ↓ move, Enter picks, Esc clears the text (an empty field lets
 * Esc close the dialog).
 */

import { useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { entityRanker } from "@/lib/payees/entity-search";
import { PayeeTypeLabel, type MerchantTypeRef } from "./merchant-type-ui";
import { useStudioT } from "./i18n";

export type EntityOption = {
  id: number;
  name: string;
  type: string;
  merchantType?: MerchantTypeRef | null;
  /** Transaction rows resolving to the entry. */
  count: number;
  aliasCount: number;
  /** Alias spellings, searched too. */
  aliases?: string[];
};

/** Rows rendered at once; the rest is reached by typing. */
const SHOWN = 60;

export function EntityPicker({
  entities,
  value,
  onChange,
  clusterKeys,
  label,
}: {
  entities: readonly EntityOption[];
  value: number | null;
  onChange: (id: number) => void;
  /** Matching keys of the payees being merged, to put alike entries first. */
  clusterKeys?: readonly string[];
  label?: string;
}) {
  const t = useStudioT();
  const fieldLabel = label ?? t("picker.label");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const rank = useMemo(() => entityRanker(entities, { clusterKeys }), [entities, clusterKeys]);
  const ranked = useMemo(() => rank(query), [rank, query]);
  const shown = ranked.slice(0, SHOWN);
  const selected = entities.find((e) => e.id === value) ?? null;
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));
  const optionId = (i: number) => `${listId}-o${i}`;

  const move = (to: number) => {
    const i = Math.max(0, Math.min(shown.length - 1, to));
    setActive(i);
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(i))}`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="space-y-1.5 min-w-0">
      <Input
        role="combobox"
        aria-label={fieldLabel}
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown.length ? optionId(activeIndex) : undefined}
        placeholder={t("picker.search")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(activeIndex + 1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(activeIndex - 1);
          } else if (e.key === "Home" && e.ctrlKey) {
            e.preventDefault();
            move(0);
          } else if (e.key === "End" && e.ctrlKey) {
            e.preventDefault();
            move(shown.length - 1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const r = shown[activeIndex];
            if (r) onChange(r.entity.id);
          } else if (e.key === "Escape" && query) {
            e.preventDefault();
            e.stopPropagation();
            setQuery("");
            setActive(0);
          }
        }}
      />
      <ul
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label={fieldLabel}
        className="max-h-60 overflow-y-auto overscroll-contain rounded-md border divide-y text-sm"
      >
        {shown.map((r, i) => {
          const e = r.entity;
          const isSelected = e.id === value;
          return (
            <li
              key={e.id}
              id={optionId(i)}
              role="option"
              aria-selected={isSelected}
              className={`flex cursor-pointer items-start gap-2 px-2 py-2 min-w-0 ${i === activeIndex ? "bg-muted" : ""} ${isSelected ? "font-medium" : ""}`}
              // Keep focus in the input so the keyboard keeps working after a click / tap.
              onMouseDown={(ev) => ev.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => onChange(e.id)}
            >
              <span aria-hidden="true" className="w-3 shrink-0 pt-0.5 text-xs">
                {isSelected ? "✓" : ""}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words [overflow-wrap:anywhere]">{e.name}</span>
                <span className="block text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
                  <PayeeTypeLabel merchantType={e.merchantType} type={e.type} />
                  {" · "}
                  {t("common.rows", { n: e.count })} · {t("common.aliases", { n: e.aliasCount })}
                  {r.via ? ` · ${t("picker.via", { via: r.via })}` : ""}
                </span>
              </span>
              {r.similarity >= 0.6 && !query && (
                <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground" title={t("picker.alikeTitle")}>
                  {t("picker.alike")}
                </span>
              )}
            </li>
          );
        })}
        {!shown.length && <li className="px-2 py-3 text-xs text-muted-foreground">{t("picker.noMatch", { query })}</li>}
      </ul>
      <p className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]" aria-live="polite">
        {selected ? <>{t("picker.into")} <span className="font-medium text-foreground">{selected.name}</span></> : t("picker.pick")}
        {ranked.length > SHOWN ? ` ${t("picker.showing", { n: SHOWN, total: ranked.length })}` : ""}
      </p>
    </div>
  );
}
