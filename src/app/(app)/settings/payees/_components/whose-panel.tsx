"use client";

/**
 * "Find by card / IBAN" (P5g): who carries a requisite — GET
 * /api/payees/requisites?action=whose&q=…. Candidates with their evidence
 * (directory / text / bank statement), transactions, dates, totals per
 * currency, typical amount, accounts and masked examples. A card's last 4
 * digits are weak: every candidate is listed with hints to tell them apart.
 * "Add to payee X" stores the requisite you typed on that entry (previewed,
 * undoable); "Show transactions" opens the filtered list.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/i18n/format-current";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import type { StudioTextKey } from "@/lib/payees/i18n";
import { OpDialog, type OpPreview } from "./op-dialog";
import { useStudioT } from "./i18n";
import { identifierQueryRefusal } from "@/lib/payees/requisites";

type Candidate = {
  entity: { id: number; name: string; type: string } | null;
  payee: string;
  evidence: Array<"directory" | "text" | "bank">;
  holdsRequisite: boolean;
  transactions: number;
  firstDate: string | null;
  lastDate: string | null;
  totals: Array<{ currency: string; paid: number; received: number }>;
  typicalAmount: number | null;
  accounts: Array<{ id: number; name: string; count: number }>;
  examples: Array<{ date: string; amount: number; currency: string; account: string; text: string; matchedVia: string }>;
};
type Report = { query: { kind: string; masked: string; strength: "strong" | "weak" }; candidates: Candidate[]; bankRows: number; hints: string[] };

const EVIDENCE: Record<string, StudioTextKey> = { directory: "whose.evidence.directory", text: "whose.evidence.text", bank: "whose.evidence.bank" };

/** The requisite to store from what the user typed (cards: last 4 digits only). */
function valueToStore(kind: string, typed: string): string {
  if (kind === "card_last4") return typed.replace(/\D/g, "").slice(-4);
  return typed.replace(/[\s-]+/g, "").toUpperCase();
}

export function WhosePanel({ onChanged }: { onChanged?: () => void }) {
  const t = useStudioT();
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState<{ entityId: number; name: string } | null>(null);
  const [status, setStatus] = useState("");

  async function find() {
    const typed = q.trim();
    if (!typed) return;
    // P6.2: a full card number is refused here, so it never reaches the server (or a URL).
    if (identifierQueryRefusal(typed)) {
      setReport(null);
      setError(t("whose.fullCard"));
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch(`/api/payees/requisites?action=whose&q=${encodeURIComponent(typed)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setReport(null);
        setError(data?.error ?? t("whose.failed"));
      } else {
        setReport(data as Report);
        setAsked(typed);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3" aria-label={t("whose.aria")}>
      <h3 className="text-sm font-medium">{t("whose.title")}</h3>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <Input className="max-w-sm" aria-label={t("whose.inputAria")} placeholder={t("whose.placeholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" type="submit" disabled={busy || !q.trim()}>
          {t("whose.find")}
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
      {report && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {report.query.masked} · {report.query.strength === "weak" ? t("whose.weak") : t("whose.strong")}
            {report.bankRows ? ` · ${t("whose.bankRows", { n: report.bankRows })}` : ""}{" "}
            <Link className="underline" href={buildTxDrillUrl({ identifier: asked })}>{t("common.showTransactions")}</Link>
          </p>
          {report.hints.length > 0 && (
            <ul className="rounded-md border border-amber-300 p-2 text-xs text-amber-800 dark:border-amber-800 dark:text-amber-200">
              {report.hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
          {report.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("whose.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {report.candidates.map((c) => (
                <li key={`${c.entity?.id ?? c.payee}`} className="rounded-lg border p-3 text-sm space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {c.entity ? (
                      <Link href={`/settings/payees/${c.entity.id}`} className="font-medium hover:underline break-all">{c.payee}</Link>
                    ) : (
                      <span className="font-medium break-all">{c.payee}</span>
                    )}
                    {c.evidence.map((e) => (
                      <Badge key={e} variant="outline">{EVIDENCE[e] ? t(EVIDENCE[e]) : e}</Badge>
                    ))}
                    <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                      {t("common.tx", { n: c.transactions })}{c.firstDate ? ` · ${formatDate(c.firstDate)} → ${formatDate(c.lastDate)}` : ""}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {c.totals.map((x) => `${t("analytics.paid", { amount: formatCurrency(x.paid, x.currency || "UAH") })}${x.received ? `, ${t("analytics.received", { amount: formatCurrency(x.received, x.currency || "UAH") })}` : ""}`).join(" · ") || t("whose.noTx")}
                    {c.typicalAmount != null ? ` · ${t("whose.usually", { amount: c.typicalAmount })}` : ""}
                    {c.accounts.length ? ` · ${t("whose.from", { list: c.accounts.map((a) => a.name).join(", ") })}` : ""}
                  </p>
                  {c.examples.length > 0 && (
                    <ul className="text-xs text-muted-foreground">
                      {c.examples.map((x, i) => (
                        <li key={i} className="truncate">{x.date} · {x.amount} {x.currency} · {x.account} · {x.text}</li>
                      ))}
                    </ul>
                  )}
                  {c.entity && !c.holdsRequisite && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdd({ entityId: c.entity!.id, name: c.entity!.name })}>
                      {t("whose.addTo", { name: c.entity.name })}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {add && report && (
        <OpDialog
          title={t("whose.addTitle", { masked: report.query.masked, name: add.name })}
          body={{ op: "identifiers", entityId: add.entityId, add: [{ kind: report.query.kind, value: valueToStore(report.query.kind, asked) }] }}
          confirmLabel={t("common.add")}
          onClose={() => setAdd(null)}
          onDone={(r: OpPreview) => {
            setAdd(null);
            setStatus(`${t("whose.added", { name: add.name })}${r.warnings.length ? " " + r.warnings.join(" ") : ""}`);
            void find();
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}
