"use client";

/**
 * "Мої рахунки і картки" (P6.2, item 76 / B27): the user's own accounts and
 * cards — IBAN, the card's last 4 digits, bank, label, currency and whose
 * (me / spouse / business). A plain reference list, nothing is imported
 * from a bank. Requisite search never suggests them, "whose card" answers
 * "your account", transfers between them stay out of the spending tops.
 * Every change is previewed and becomes an undoable batch; a full card
 * number is refused by the server.
 */

import { useState } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OpDialog, type OpPreview } from "./op-dialog";
import { useStudioT } from "./i18n";

type Owner = "me" | "spouse" | "business";
const OWNERS: Owner[] = ["me", "spouse", "business"];
const OWNER_KEY = { me: "own.owner.me", spouse: "own.owner.spouse", business: "own.owner.business" } as const;

export type OwnAccountRow = {
  id: number;
  iban: string | null;
  card: string | null;
  bank: string | null;
  label: string | null;
  currency: string | null;
  owner: Owner;
  description: string;
};

type Draft = { iban: string; card: string; bank: string; label: string; currency: string; owner: Owner };
const EMPTY: Draft = { iban: "", card: "", bank: "", label: "", currency: "", owner: "me" };

type Action = { kind: "add" } | { kind: "remove"; row: OwnAccountRow } | { kind: "owner"; row: OwnAccountRow; owner: Owner };

export function OwnAccountsPanel({ onChanged }: { onChanged?: () => void }) {
  const t = useStudioT();
  const { data, mutate } = useSWR<{ ownAccounts: OwnAccountRow[] }>("/api/payees/own-accounts", jsonFetcher);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [action, setAction] = useState<Action | null>(null);
  const [status, setStatus] = useState("");
  const rows = data?.ownAccounts ?? [];

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const addBody = () => {
    if (!draft.iban.trim() && !draft.card.trim()) return null;
    const item: Record<string, string> = { owner: draft.owner };
    for (const k of ["iban", "card", "bank", "label", "currency"] as const) if (draft[k].trim()) item[k] = draft[k].trim();
    return { op: "own_accounts", add: [item] };
  };
  const finish = (_r: OpPreview) => {
    setAction(null);
    setDraft(EMPTY);
    setStatus(t("own.done"));
    mutate();
    onChanged?.();
  };
  const ownerSelect = (value: Owner, onChange: (o: Owner) => void, label: string) => (
    <select aria-label={label} className="h-8 rounded-md border bg-background px-2 text-xs" value={value} onChange={(e) => onChange(e.target.value as Owner)}>
      {OWNERS.map((o) => (
        <option key={o} value={o}>
          {t(OWNER_KEY[o])}
        </option>
      ))}
    </select>
  );

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{t("own.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("own.intro")}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("own.empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 p-2">
              <span className="break-all">{r.description}</span>
              <span className="ms-auto flex items-center gap-1.5">
                {ownerSelect(r.owner, (o) => o !== r.owner && setAction({ kind: "owner", row: r, owner: o }), t("own.owner"))}
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAction({ kind: "remove", row: r })}>
                  {t("own.remove")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Input className="w-64" aria-label={t("own.iban")} placeholder={t("own.iban")} value={draft.iban} onChange={set("iban")} />
        <Input className="w-40" aria-label={t("own.card")} placeholder="**** 1234" value={draft.card} onChange={set("card")} />
        <Input className="w-32" aria-label={t("own.bank")} placeholder={t("own.bank")} value={draft.bank} onChange={set("bank")} />
        <Input className="w-32" aria-label={t("own.label")} placeholder={t("own.label")} value={draft.label} onChange={set("label")} />
        <Input className="w-20" aria-label={t("own.currency")} placeholder="UAH" value={draft.currency} onChange={set("currency")} />
        {ownerSelect(draft.owner, (o) => setDraft((d) => ({ ...d, owner: o })), t("own.owner"))}
        <Button size="sm" disabled={!addBody()} onClick={() => setAction({ kind: "add" })}>
          {t("own.add")}
        </Button>
      </div>
      {status && <p className="text-xs text-emerald-600 dark:text-emerald-400">{status}</p>}

      {action?.kind === "add" && <OpDialog title={t("own.addTitle")} body={addBody()} onClose={() => setAction(null)} onDone={finish} confirmLabel={t("own.add")} />}
      {action?.kind === "remove" && (
        <OpDialog
          title={t("own.removeTitle", { name: action.row.description })}
          body={{ op: "own_accounts", remove: [action.row.id] }}
          onClose={() => setAction(null)}
          onDone={finish}
          confirmLabel={t("own.remove")}
        />
      )}
      {action?.kind === "owner" && (
        <OpDialog
          title={t("own.ownerTitle", { name: action.row.description })}
          body={{ op: "own_accounts", update: [{ id: action.row.id, owner: action.owner }] }}
          onClose={() => setAction(null)}
          onDone={finish}
        />
      )}
    </section>
  );
}
