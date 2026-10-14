"use client";

/**
 * Global Merchants search (P8 stage 1): Ctrl/Cmd+K anywhere in the app (an
 * icon on phones, via <MerchantSearchButton/>). Finds a merchant by name,
 * alias or a recent spelling, or by a requisite — IBAN, a card's last 4
 * digits or mask, ІПН / ЄДРПОУ (GET /api/payees/search). A requisite also
 * offers "Whose card / account is it?", which opens Merchants → Channels and
 * runs the full search there; the requisite travels in sessionStorage, never
 * in the URL. A full card number is refused before anything is sent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Store, User, Landmark, Clock, CreditCard } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { identifierQueryRefusal } from "@/lib/payees/requisites";
import { cn } from "@/lib/utils";

export const MERCHANT_SEARCH_EVENT = "finlynq:merchant-search";
export const WHOSE_PENDING_KEY = "finlynq.merchants.whose";

type Hit = {
  kind: "entity" | "alias" | "recent" | "requisite";
  label: string;
  entityId: number | null;
  entityName: string | null;
  type: string | null;
  detail: string | null;
  count?: number;
};
type Result = { hits: Hit[]; requisite: { kind: string; masked: string; strength: "strong" | "weak" } | null; own: string | null; refusal: string | null };

type Row = { id: string; label: string; detail: string | null; icon: typeof Store; go: () => void };

/** Open the search from anywhere (a button on phones, a menu item). */
export function openMerchantSearch() {
  window.dispatchEvent(new Event(MERCHANT_SEARCH_EVENT));
}

export function MerchantSearchButton({ className }: { className?: string }) {
  const t = useT();
  return (
    <Button variant="outline" size="sm" className={className} aria-label={t("search.open")} title={t("search.open")} onClick={openMerchantSearch}>
      <Search className="h-4 w-4" />
    </Button>
  );
}

export function MerchantSearch() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(MERCHANT_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(MERCHANT_SEARCH_EVENT, onOpen);
    };
  }, []);

  const refusal = q.trim() && identifierQueryRefusal(q) ? t("search.fullCard") : "";

  const run = useCallback(async (text: string) => {
    const id = ++seq.current;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/payees/search?q=${encodeURIComponent(text)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as Result;
      if (id === seq.current) {
        setResult(data);
        setActive(0);
      }
    } catch {
      if (id === seq.current) setError(true);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!open || !text || refusal) return;
    const h = setTimeout(() => void run(text), 200);
    return () => clearTimeout(h);
  }, [q, open, refusal, run]);

  function close() {
    setOpen(false);
    setQ("");
    setResult(null);
    setError(false);
  }
  function go(href: string) {
    close();
    router.push(href);
  }

  const shown = q.trim() && !refusal ? result : null;
  const rows: Row[] = [];
  for (const h of shown?.hits ?? []) {
    const icon = h.kind === "requisite" ? CreditCard : h.kind === "recent" ? Clock : h.type === "person" || h.type === "sole_proprietor" ? User : Store;
    const detail =
      h.kind === "requisite" ? t("search.byRequisite", { value: h.detail ?? "" }) : h.kind === "alias" ? t("search.byAlias", { alias: h.detail ?? "" }) : h.kind === "recent" ? t("search.notInDirectory") : null;
    rows.push({
      id: `${h.kind}:${h.entityId ?? h.label}`,
      label: h.label,
      detail,
      icon,
      go: () => go(h.entityId != null ? `/merchants/${h.entityId}` : `/merchants?tab=directory&view=spellings&q=${encodeURIComponent(h.label)}`),
    });
  }
  if (shown?.requisite) {
    const typed = q.trim();
    rows.push({
      id: "whose",
      label: t("search.whose", { value: shown.requisite.masked }),
      detail: shown.requisite.strength === "weak" ? t("search.weak") : null,
      icon: Landmark,
      go: () => {
        try {
          window.sessionStorage.setItem(WHOSE_PENDING_KEY, typed);
        } catch {
          /* storage blocked: the panel opens empty */
        }
        go("/merchants?tab=channels");
      },
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!rows.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[Math.min(active, rows.length - 1)]?.go();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent className="sm:max-w-lg top-[15%] translate-y-0 p-0 gap-0">
        <DialogHeader className="p-3 pb-2">
          <DialogTitle className="text-sm">{t("search.title")}</DialogTitle>
          <DialogDescription className="text-xs">{t("search.description")}</DialogDescription>
        </DialogHeader>
        <div className="relative px-3">
          <Search className="absolute start-5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            autoFocus
            className="ps-8"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="merchant-search-list"
            aria-label={t("search.title")}
            placeholder={t("search.placeholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2 text-sm" aria-live="polite">
          {refusal ? (
            <p className="p-2 text-destructive">{refusal}</p>
          ) : !q.trim() ? (
            <p className="p-2 text-xs text-muted-foreground">{t("search.empty")}</p>
          ) : error ? (
            <div className="flex items-center gap-2 p-2">
              <span className="text-destructive">{t("search.failed")}</span>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void run(q.trim())}>
                {t("common.retry")}
              </Button>
            </div>
          ) : loading && !shown ? (
            <ul className="space-y-1" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-9 animate-pulse rounded-md bg-muted" />
              ))}
            </ul>
          ) : (
            <>
              {shown?.own && <p className="mb-1 rounded-md bg-muted/60 p-2 text-xs">{t("search.own", { account: shown.own })}</p>}
              {rows.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">{t("search.nothing")}</p>
              ) : (
                <ul id="merchant-search-list" role="listbox" aria-label={t("search.results")} className="space-y-0.5">
                  {rows.map((r, i) => (
                    <li key={r.id} role="option" aria-selected={i === active}>
                      <button
                        type="button"
                        className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start", i === active ? "bg-accent" : "hover:bg-accent/60")}
                        onMouseEnter={() => setActive(i)}
                        onClick={r.go}
                      >
                        <r.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{r.label}</span>
                        {r.detail && <span className="shrink-0 text-xs text-muted-foreground">{r.detail}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">{t("search.footer")}</p>
      </DialogContent>
    </Dialog>
  );
}
