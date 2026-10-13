"use client";

/**
 * PayeePicker — the one payee field (P8 stage 4; replaces PayeeCombobox).
 *
 *  - Suggestions: directory names, their aliases (choosing one fills in the
 *    canonical name) and recent payees (GET /api/payees/suggest).
 *  - Free text is an explicit choice: a name that is not in the directory
 *    ends the list with «Додати «X» в довідник» (creates the entry, nothing
 *    is renamed) and «Тільки текст». With the setting «Вимагати платника з
 *    довідника» (Merchants settings, OFF by default) only the first is offered
 *    and the field says so until a directory payee is chosen.
 *  - «Рекомендовано: X»: when the text resolves to a directory entry through
 *    an alias (GET /api/payees/resolve), a chip offers the canonical name.
 *  - On phones the list opens as a bottom sheet.
 *  - Keyboard: ↓ / ↑ move, Enter picks, Escape closes.
 *
 * The strict "pick an existing entry" list of the Studio (merge / check
 * dialogs) is <EntityPicker> — the same rows, no free text.
 *
 * Entry points (stage 0 audit): transaction dialog (new / edit), bulk payee
 * change, staged-row editor, email inbox «Record», email-rule payee
 * override, rule «rename payee», portfolio forms — all use this field.
 * Deliberate exceptions: the Studio's own name fields (they define a new
 * canonical name), the mobile app (separate React Native client), and the
 * places with no payee input (imports, reconcile, MCP — they resolve on the
 * server).
 */

import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { BookPlus, Sparkles, Type } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { useNarrow } from "@/components/actions/use-narrow";

export type PayeeSuggestion = {
  value: string;
  label: string;
  kind: "entity" | "alias" | "recent";
  entityId: number | null;
  entityName: string | null;
  type: string | null;
  count?: number;
};

type Recommendation = { kind: "match"; entityId: number; name: string; via: string; same: boolean } | { kind: "ambiguous"; names: string[] } | { kind: "none" };

/** What the field holds: a directory entry (picked, added or exactly its name), or free text. */
export type PayeeFieldState = { value: string; entityId: number | null; fromDirectory: boolean; freeText: boolean; required: boolean };

const fetchSuggestions = async (url: string): Promise<PayeeSuggestion[]> => {
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as { suggestions?: PayeeSuggestion[] } | null;
  return data?.suggestions ?? [];
};
const fetchJson = async <T,>(url: string): Promise<T | null> => {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
};

type Row =
  | { kind: "suggestion"; s: PayeeSuggestion }
  | { kind: "add"; name: string }
  | { kind: "text"; name: string };

const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

export function PayeePicker({
  value,
  onChange,
  onPick,
  onStateChange,
  placeholder,
  className,
  inputClassName,
  ariaLabel,
  limit = 8,
  disabled,
  id,
  recommend = true,
  offerAdd = true,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Called when a suggestion is chosen (after onChange). */
  onPick?: (s: PayeeSuggestion) => void;
  /** P8: whether the value is a directory payee, free text, and whether the setting requires the former. */
  onStateChange?: (s: PayeeFieldState) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
  limit?: number;
  disabled?: boolean;
  id?: string;
  /** Show «Рекомендовано: X» when the text resolves to a directory entry. */
  recommend?: boolean;
  /** Offer «Додати в довідник» for a name that is not there. */
  offerAdd?: boolean;
}) {
  const t = useT();
  const narrow = useNarrow();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState(value);
  const [picked, setPicked] = useState<{ value: string; entityId: number | null } | null>(null);
  const [freeText, setFreeText] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  // Debounce the query that hits the server.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(value), 150);
    return () => clearTimeout(timer);
  }, [value]);

  const { data: settings } = useSWR<{ requireDirectoryPayee?: boolean } | null>("/api/payees/settings", fetchJson, { revalidateOnFocus: false });
  const required = Boolean(settings?.requireDirectoryPayee);
  const { data } = useSWR(open ? `/api/payees/suggest?q=${encodeURIComponent(query.trim())}&limit=${limit}` : null, fetchSuggestions, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
  const trimmed = value.trim();
  const { data: rec } = useSWR<Recommendation | null>(
    (recommend || required) && trimmed && !(picked && picked.value === value) ? `/api/payees/resolve?payee=${encodeURIComponent(query.trim())}` : null,
    fetchJson,
    { revalidateOnFocus: false, keepPreviousData: false },
  );

  const suggestions = (data ?? []).filter((s) => !(s.kind !== "alias" && s.value === value));
  const exactEntity = (data ?? []).find((s) => s.kind === "entity" && same(s.value, value));
  const resolvedId =
    picked && picked.value === value
      ? picked.entityId
      : rec?.kind === "match" && rec.same
        ? rec.entityId
        : exactEntity?.entityId ?? null;
  const fromDirectory = resolvedId != null;
  const rows: Row[] = suggestions.map((s) => ({ kind: "suggestion", s }));
  if (trimmed && !fromDirectory && !(data ?? []).some((s) => s.kind !== "recent" && same(s.value, value))) {
    if (offerAdd) rows.push({ kind: "add", name: trimmed });
    if (!required) rows.push({ kind: "text", name: trimmed });
  }

  const isFree = !fromDirectory && freeText === value && Boolean(trimmed);
  // Report only real changes, so a parent that stores the state never loops.
  const lastReport = useRef("");
  const onState = useRef(onStateChange);
  useEffect(() => {
    onState.current = onStateChange;
  });
  useEffect(() => {
    const state: PayeeFieldState = { value, entityId: resolvedId, fromDirectory, freeText: isFree, required };
    const key = JSON.stringify(state);
    if (key === lastReport.current) return;
    lastReport.current = key;
    onState.current?.(state);
  }, [value, resolvedId, fromDirectory, isFree, required]);

  useEffect(() => {
    if (!open || narrow) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, narrow]);

  function pick(s: PayeeSuggestion) {
    onChange(s.value);
    setPicked({ value: s.value, entityId: s.entityId });
    onPick?.(s);
    setOpen(false);
    setActive(-1);
  }

  async function addToDirectory(name: string) {
    setAdding(true);
    setNote("");
    const res = await fetch("/api/payees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "create", name, apply: false }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    setAdding(false);
    if (!res?.ok || !json?.entity) {
      setNote(json?.error || t("payeePicker.addFailed"));
      return;
    }
    onChange(json.entity.name);
    setPicked({ value: json.entity.name, entityId: json.entity.id });
    setNote(t("payeePicker.added", { name: json.entity.name }));
    setOpen(false);
  }

  function choose(r: Row) {
    if (r.kind === "suggestion") pick(r.s);
    else if (r.kind === "add") void addToDirectory(r.name);
    else {
      setFreeText(value);
      setOpen(false);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter" && open && active >= 0 && rows[active]) {
      e.preventDefault();
      choose(rows[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const input = (sheet: boolean) => (
    <Input
      id={sheet ? undefined : id}
      role="combobox"
      aria-label={ariaLabel ?? t("payeePicker.label")}
      aria-expanded={open && rows.length > 0}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
      autoComplete="off"
      autoFocus={sheet}
      disabled={disabled || adding}
      className={sheet ? undefined : inputClassName}
      placeholder={placeholder}
      value={value}
      onFocus={() => setOpen(true)}
      onClick={() => setOpen(true)}
      onChange={(e) => {
        onChange(e.target.value);
        setOpen(true);
        setActive(-1);
        setNote("");
      }}
      onKeyDown={onKeyDown}
    />
  );

  const list = (sheet: boolean) =>
    rows.length > 0 ? (
      <ul
        id={listId}
        role="listbox"
        aria-label={t("payeePicker.suggestions")}
        className={cn(
          "overflow-y-auto rounded-md border bg-popover p-1 text-sm",
          sheet ? "max-h-[55vh]" : "absolute z-50 mt-1 max-h-64 w-full min-w-56 shadow-md",
        )}
      >
        {rows.map((r, i) => (
          <li
            key={r.kind === "suggestion" ? `${r.s.kind}|${r.s.value}|${r.s.label}` : r.kind}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded px-2",
              sheet ? "py-2.5" : "py-1",
              i === active ? "bg-accent" : "hover:bg-accent/60",
              r.kind !== "suggestion" && "border-t first:border-t-0",
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(r);
            }}
          >
            {r.kind === "suggestion" ? (
              <>
                <span className="min-w-0 flex-1 truncate">{r.s.label}</span>
                {r.s.kind === "alias" && <span className="shrink-0 truncate text-xs text-muted-foreground">→ {r.s.value}</span>}
                {r.s.kind === "entity" && <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{t("payeePicker.directory")}</span>}
                {r.s.kind === "recent" && r.s.count ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">× {r.s.count}</span> : null}
              </>
            ) : r.kind === "add" ? (
              <>
                <BookPlus className="h-4 w-4 shrink-0 text-action-confirm-text" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t("payeePicker.add", { name: r.name })}</span>
              </>
            ) : (
              <>
                <Type className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t("payeePicker.textOnly")}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    ) : null;

  const chip =
    recommend && rec?.kind === "match" && !rec.same && trimmed ? (
      <button
        type="button"
        className="mt-1 inline-flex max-w-full items-center gap-1 rounded-full border border-action-open-text/40 px-2 py-0.5 text-xs text-action-open-text hover:bg-action-open/10"
        title={t("payeePicker.recommendedTitle", { via: rec.via })}
        onClick={() => {
          onChange(rec.name);
          setPicked({ value: rec.name, entityId: rec.entityId });
        }}
      >
        <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{t("payeePicker.recommended", { name: rec.name })}</span>
      </button>
    ) : null;

  return (
    <div ref={wrap} className={cn("relative", className)}>
      {input(false)}
      {!narrow && open && list(false)}
      {narrow && (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[85vh] gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <SheetHeader className="p-0">
              <SheetTitle>{ariaLabel ?? t("payeePicker.label")}</SheetTitle>
            </SheetHeader>
            {input(true)}
            {list(true)}
          </SheetContent>
        </Sheet>
      )}
      {chip}
      {note && <p className="mt-1 text-xs text-muted-foreground" role="status">{note}</p>}
      {required && trimmed && !fromDirectory && !adding && (
        <p className="mt-1 text-xs text-action-caution-text">{t("payeePicker.required")}</p>
      )}
    </div>
  );
}
