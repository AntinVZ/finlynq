"use client";

/**
 * "Counterparty requisites found" (Payee Studio P5g, reverse direction): the
 * card masks, IBANs and signed ЄДРПОУ / ІПН codes in a transaction's payee
 * and note, shown masked, each with "Add to payee" — stored on the directory
 * entry the payee resolves to (previewed, one undoable batch). Card numbers
 * are kept as their last 4 digits only. Renders nothing when nothing is found.
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { extractRequisites } from "@/lib/payees/requisites";
import { OpDialog } from "@/app/(app)/merchants/_components/op-dialog";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";

const KIND: Record<string, MessageKey> = { iban: "mine.kind.iban", card_last4: "mine.kind.card_last4", tax_id: "mine.kind.tax_id", edrpou: "mine.kind.edrpou" };

const fetchEntity = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { entity?: { id: number; name: string } | null } | null;
  return data?.entity ?? null;
};

export function CounterpartyRequisites({ payee, note }: { payee: string; note: string }) {
  const t = useT();
  const found = useMemo(() => {
    const seen = new Set<string>();
    return [...extractRequisites(payee), ...extractRequisites(note)].filter((r) => {
      const k = `${r.kind}:${r.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [payee, note]);
  const { data: entity } = useSWR(found.length && payee.trim() ? `/api/payees/requisites?action=resolve&payee=${encodeURIComponent(payee.trim())}` : null, fetchEntity, {
    revalidateOnFocus: false,
  });
  const [adding, setAdding] = useState<{ kind: string; value: string; masked: string } | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  if (!found.length) return null;
  return (
    <div className="rounded-md border p-2 text-xs space-y-1" aria-label={t("counterparty.title")}>
      <p className="font-medium">{t("counterparty.title")}</p>
      <ul className="space-y-1">
        {found.map((r) => (
          <li key={`${r.kind}:${r.value}`} className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{KIND[r.kind] ? t(KIND[r.kind]) : r.kind}</span>
            <span className="font-mono">{r.masked}</span>
            {!r.valid && <span className="text-amber-700 dark:text-amber-300">{t("counterparty.checkDigits")}</span>}
            {done.has(`${r.kind}:${r.value}`) ? (
              <span className="ms-auto text-emerald-600">{t("counterparty.added")}</span>
            ) : entity ? (
              <Button type="button" size="sm" variant="outline" className="ms-auto h-6 text-xs" onClick={() => setAdding(r)}>
                {t("counterparty.addTo", { name: entity.name })}
              </Button>
            ) : (
              <span className="ms-auto text-muted-foreground">{t("counterparty.needEntity")}</span>
            )}
          </li>
        ))}
      </ul>
      {adding && entity && (
        <OpDialog
          title={t("counterparty.addTitle", { masked: adding.masked, name: entity.name })}
          body={{ op: "identifiers", entityId: entity.id, add: [{ kind: adding.kind, value: adding.value }] }}
          confirmLabel={t("common.add")}
          onClose={() => setAdding(null)}
          onDone={() => {
            setDone((d) => new Set(d).add(`${adding.kind}:${adding.value}`));
            setAdding(null);
          }}
        />
      )}
    </div>
  );
}
