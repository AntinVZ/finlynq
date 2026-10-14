"use client";

/**
 * "Look for requisites in my transactions" (P5f): runs GET
 * /api/payees/requisites?action=mine only when the button is pressed, lists
 * masked suggestions (IBAN, card last 4, signed ЄДРПОУ / ІПН) per payee and
 * "links" (a known IBAN / code found under another spelling); the chosen ones
 * are saved as DRAFT proposals for the AI review page — nothing changes yet.
 */

import { formatDate } from "@/lib/i18n/format-current";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { StudioTextKey } from "@/lib/payees/i18n";
import { useStudioT } from "./i18n";

type Suggestion = {
  ref: string;
  counterparty: { entityId: number | null; name: string };
  kind: string;
  masked: string;
  valid: boolean;
  rows: number;
  firstDate: string | null;
  lastDate: string | null;
  ownedBy: Array<{ id: number; name: string }>;
  example: string;
};
type LinkS = { ref: string; payee: string; entity: { id: number; name: string }; via: string; rows: number };
type Report = { suggestions: Suggestion[]; links: LinkS[]; scanned: { transactions: number; bank: number }; truncated: boolean };

const KIND: Record<string, StudioTextKey> = { iban: "mine.kind.iban", card_last4: "mine.kind.card_last4", tax_id: "mine.kind.tax_id", edrpou: "mine.kind.edrpou", crypto_wallet: "mine.kind.crypto_wallet" };

export function MinePanel({ onSaved }: { onSaved?: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const t = useStudioT();
  const [status, setStatus] = useState("");
  /** The status is "saved N drafts" (shows the link to AI review). */
  const [saved, setSaved] = useState(false);
  const kindLabel = (kind: string) => (KIND[kind] ? t(KIND[kind]) : kind);

  async function run() {
    setBusy(true);
    setStatus("");
    setSaved(false);
    try {
      const res = await fetch("/api/payees/requisites?action=mine");
      const data = await res.json().catch(() => null);
      if (!res.ok) setStatus(data?.error ?? t("mine.failed"));
      else {
        setReport(data as Report);
        setPicked(new Set());
      }
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/payees/requisites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "propose", refs: [...picked] }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setStatus(data?.error ?? t("mine.saveFailed"));
        setSaved(false);
      } else {
        setStatus(t("mine.saved", { n: data.saved.length }));
        setSaved(true);
        setPicked(new Set());
        onSaved?.();
      }
    } finally {
      setBusy(false);
    }
  }

  const toggle = (ref: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(ref)) n.delete(ref);
      else n.add(ref);
      return n;
    });

  return (
    <section className="space-y-3" aria-label={t("mine.aria")}>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={run}>
          {busy && !report ? t("mine.looking") : t("mine.run")}
        </Button>
        {report && picked.size > 0 && (
          <Button size="sm" disabled={busy} onClick={save}>
            {t("mine.save", { n: picked.size })}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">{t("mine.intro")}</span>
      </div>
      {status && (
        <p className="text-sm">
          {status} {saved && <Link href="/merchants/review" className="underline">{t("mine.openReview")}</Link>}
        </p>
      )}
      {report && (
        <>
          <p className="text-xs text-muted-foreground">
            {t("mine.scanned", { tx: report.scanned.transactions.toLocaleString("en-US"), bank: report.scanned.bank.toLocaleString("en-US") })}
            {report.truncated ? ` ${t("mine.stoppedEarly")}` : ""}.
          </p>
          {report.links.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-1">{t("mine.links")}</h3>
              <ul className="divide-y rounded-lg border">
                {report.links.map((l) => (
                  <li key={l.ref} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                    <input type="checkbox" aria-label={t("mine.pickLink", { name: l.payee })} checked={picked.has(l.ref)} onChange={() => toggle(l.ref)} />
                    <span className="break-all">“{l.payee}”</span> → <Link href={`/merchants/${l.entity.id}`} className="font-medium hover:underline">{l.entity.name}</Link>
                    <span className="text-xs text-muted-foreground">{t("mine.via", { via: l.via })} · {t("common.rows", { n: l.rows })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("mine.empty")}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {report.suggestions.map((s) => (
                <li key={s.ref} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                  <input type="checkbox" aria-label={t("mine.pick", { kind: kindLabel(s.kind), masked: s.masked })} checked={picked.has(s.ref)} onChange={() => toggle(s.ref)} />
                  <Badge variant="outline">{kindLabel(s.kind)}</Badge>
                  <span className="font-mono">{s.masked}</span>
                  {!s.valid && <Badge variant="outline" className="border-amber-300 text-amber-700">{t("mine.checkDigit")}</Badge>}
                  {s.kind === "card_last4" && <span className="text-xs text-muted-foreground">{t("mine.weak")}</span>}
                  <span className="text-muted-foreground">{t("mine.for")}</span>
                  {s.counterparty.entityId != null ? (
                    <Link href={`/merchants/${s.counterparty.entityId}`} className="font-medium hover:underline break-all">{s.counterparty.name}</Link>
                  ) : (
                    <span className="font-medium break-all">{s.counterparty.name}</span>
                  )}
                  <span className="ms-auto text-xs text-muted-foreground tabular-nums">{t("common.rows", { n: s.rows })} · {formatDate(s.firstDate)} → {formatDate(s.lastDate)}</span>
                  {s.ownedBy.length > 0 && <span className="w-full text-xs text-amber-700 dark:text-amber-300">{t("mine.alsoOn", { list: s.ownedBy.map((o) => o.name).join(", ") })}</span>}
                  <span className="w-full truncate text-xs text-muted-foreground">{s.example}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
