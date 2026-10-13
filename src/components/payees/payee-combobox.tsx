"use client";

/**
 * PayeeCombobox — a payee text box with suggestions (Payee Studio P5a).
 *
 * Free text is always allowed: the list only offers directory canonical
 * names, their aliases (choosing one fills in the canonical name) and recent
 * distinct payees, from GET /api/payees/suggest (debounced, cached by SWR).
 * Keyboard: ↓/↑ move, Enter picks, Escape closes. `onPick` also reports the
 * directory entity behind a choice (the rule editor uses it).
 */

import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export type PayeeSuggestion = {
  value: string;
  label: string;
  kind: "entity" | "alias" | "recent";
  entityId: number | null;
  entityName: string | null;
  type: string | null;
  count?: number;
};

const fetchSuggestions = async (url: string): Promise<PayeeSuggestion[]> => {
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as { suggestions?: PayeeSuggestion[] } | null;
  return data?.suggestions ?? [];
};

export function PayeeCombobox({
  value,
  onChange,
  onPick,
  placeholder,
  className,
  inputClassName,
  ariaLabel,
  limit = 8,
  disabled,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Called when a suggestion is chosen (after onChange). */
  onPick?: (s: PayeeSuggestion) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
  limit?: number;
  disabled?: boolean;
  id?: string;
}) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState(value);
  const wrap = useRef<HTMLDivElement>(null);

  // Debounce the query that hits the server.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(value), 150);
    return () => clearTimeout(timer);
  }, [value]);

  const { data } = useSWR(open ? `/api/payees/suggest?q=${encodeURIComponent(query.trim())}&limit=${limit}` : null, fetchSuggestions, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
  const items = (data ?? []).filter((s) => !(s.kind !== "alias" && s.value === value));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(s: PayeeSuggestion) {
    onChange(s.value);
    onPick?.(s);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div ref={wrap} className={cn("relative", className)}>
      <Input
        id={id}
        role="combobox"
        aria-label={ariaLabel ?? t("payeePicker.label")}
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        className={inputClassName}
        placeholder={placeholder}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(items.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(-1, i - 1));
          } else if (e.key === "Enter" && open && active >= 0 && items[active]) {
            e.preventDefault();
            pick(items[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && items.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("payeePicker.suggestions")}
          className="absolute z-50 mt-1 max-h-64 w-full min-w-56 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          {items.map((s, i) => (
            <li
              key={`${s.kind}|${s.value}|${s.label}`}
              role="option"
              aria-selected={i === active}
              className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1", i === active ? "bg-accent" : "hover:bg-accent/60")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              {s.kind === "alias" && <span className="shrink-0 truncate text-xs text-muted-foreground">→ {s.value}</span>}
              {s.kind === "entity" && <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{t("payeePicker.directory")}</span>}
              {s.kind === "recent" && s.count ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">× {s.count}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
