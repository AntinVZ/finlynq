"use client";

/**
 * "Look for requisites in my transactions" (P5f): runs GET
 * /api/payees/requisites?action=mine only when the button is pressed, lists
 * masked suggestions (IBAN, card last 4, signed ЄДРПОУ / ІПН) per payee and
 * "links" (a known IBAN / code found under another spelling); the chosen ones
 * are saved as DRAFT proposals for the AI review page — nothing changes yet.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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

const KIND: Record<string, string> = { iban: "IBAN", card_last4: "Card", tax_id: "ІПН", edrpou: "EDRPOU", crypto_wallet: "Wallet" };

export function MinePanel({ onSaved }: { onSaved?: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");

  async function run() {
    setBusy(true);
    setStatus("");
    try {
      const res = await fetch("/api/payees/requisites?action=mine");
      const data = await res.json().catch(() => null);
      if (!res.ok) setStatus(data?.error ?? "Couldn't look for requisites.");
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
      if (!res.ok) setStatus(data?.error ?? "Couldn't save.");
      else {
        setStatus(`Saved ${data.saved.length} draft(s) for review.`);
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
    <section className="space-y-3" aria-label="Look for requisites">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={run}>
          {busy && !report ? "Looking…" : "Look for requisites in my transactions"}
        </Button>
        {report && picked.size > 0 && (
          <Button size="sm" disabled={busy} onClick={save}>
            Save {picked.size} as drafts for review
          </Button>
        )}
        <span className="text-xs text-muted-foreground">IBANs, card masks (last 4 digits only) and codes written as “ЄДРПОУ …” / “ІПН …” in payees, notes and bank statements. Bare numbers are ignored.</span>
      </div>
      {status && (
        <p className="text-sm">
          {status} {status.startsWith("Saved") && <Link href="/settings/payees/review" className="underline">Open AI review</Link>}
        </p>
      )}
      {report && (
        <>
          <p className="text-xs text-muted-foreground">
            Read {report.scanned.transactions.toLocaleString("en-US")} transactions and {report.scanned.bank.toLocaleString("en-US")} bank-statement rows{report.truncated ? " (stopped early)" : ""}.
          </p>
          {report.links.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-1">Probably the same payee (a known requisite in the text)</h3>
              <ul className="divide-y rounded-lg border">
                {report.links.map((l) => (
                  <li key={l.ref} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                    <input type="checkbox" aria-label={`Pick link ${l.payee}`} checked={picked.has(l.ref)} onChange={() => toggle(l.ref)} />
                    <span className="break-all">“{l.payee}”</span> → <Link href={`/settings/payees/${l.entity.id}`} className="font-medium hover:underline">{l.entity.name}</Link>
                    <span className="text-xs text-muted-foreground">via {l.via} · {l.rows} row(s)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {report.suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No new requisites found.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {report.suggestions.map((s) => (
                <li key={s.ref} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                  <input type="checkbox" aria-label={`Pick ${KIND[s.kind] ?? s.kind} ${s.masked}`} checked={picked.has(s.ref)} onChange={() => toggle(s.ref)} />
                  <Badge variant="outline">{KIND[s.kind] ?? s.kind}</Badge>
                  <span className="font-mono">{s.masked}</span>
                  {!s.valid && <Badge variant="outline" className="border-amber-300 text-amber-700">check digit fails</Badge>}
                  {s.kind === "card_last4" && <span className="text-xs text-muted-foreground">weak evidence</span>}
                  <span className="text-muted-foreground">for</span>
                  {s.counterparty.entityId != null ? (
                    <Link href={`/settings/payees/${s.counterparty.entityId}`} className="font-medium hover:underline break-all">{s.counterparty.name}</Link>
                  ) : (
                    <span className="font-medium break-all">{s.counterparty.name}</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{s.rows} row(s) · {s.firstDate ?? "—"} → {s.lastDate ?? "—"}</span>
                  {s.ownedBy.length > 0 && <span className="w-full text-xs text-amber-700 dark:text-amber-300">Also on: {s.ownedBy.map((o) => o.name).join(", ")}</span>}
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
