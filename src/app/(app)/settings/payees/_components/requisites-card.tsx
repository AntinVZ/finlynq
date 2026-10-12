"use client";

/**
 * Requisites of one payee (Payee Studio P5f): several cards / accounts per
 * kind, each with a label, bank, currency, primary / inactive flags; add,
 * edit, deactivate, remove — every change previewed (OpDialog), one undoable
 * batch. Only the kinds that fit the payee's type are offered: people / ФОП
 * get ІПН (РНОКПП, 10 digits) and no EDRPOU; companies get EDRPOU (8 digits)
 * and no ІПН. A code that doesn't fit the type, or a failed check digit, is
 * explained as a warning in the preview, never refused.
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export type Requisite = {
  id: number;
  kind: string;
  value: string;
  label: string | null;
  bank: string | null;
  currency: string | null;
  isPrimary: boolean;
  isActive: boolean;
};

export const REQUISITE_LABEL: Record<string, string> = {
  iban: "IBAN accounts",
  tax_id: "Tax id (ІПН / РНОКПП)",
  edrpou: "EDRPOU",
  card_last4: "Cards (last 4 digits)",
  crypto_wallet: "Crypto wallets",
};

const PERSONISH = new Set(["person", "sole_proprietor"]);

/** Mirrors lib/payees/directory.ts identifierKindsForType. */
export function kindsForType(type: string): string[] {
  if (PERSONISH.has(type)) return ["iban", "card_last4", "tax_id", "crypto_wallet"];
  if (type === "company" || type === "bank" || type === "government") return ["iban", "card_last4", "edrpou", "crypto_wallet"];
  return ["iban", "card_last4", "edrpou", "tax_id", "crypto_wallet"];
}

/** A client-side hint while typing a code (the server checks the digits too). */
export function codeTypeHint(kind: string, value: string, type: string): string | null {
  const d = value.replace(/\D/g, "");
  if (kind === "tax_id" && d.length === 8) return "8 digits looks like an EDRPOU (a legal entity's code), not an ІПН.";
  if (kind === "edrpou" && d.length === 10) return "10 digits looks like an ІПН / РНОКПП (a person or ФОП), not an EDRPOU.";
  if (kind === "edrpou" && PERSONISH.has(type)) return "A ФОП or private person has no EDRPOU; if this is a company, change the type to Company.";
  if (kind === "tax_id" && !PERSONISH.has(type) && type !== "other") return "An ІПН belongs to a person or ФОП; consider changing the type.";
  return null;
}

const shown = (r: Requisite) => (r.kind === "card_last4" ? `•••• ${r.value}` : r.value);

type Action = { title: string; body: Record<string, unknown>; confirm: string };

export function RequisitesCard({
  entityId,
  entityType,
  requisites,
  allowedKinds,
  onAction,
}: {
  entityId: number;
  entityType: string;
  requisites: Requisite[];
  /** Kinds enabled in Studio settings. */
  allowedKinds: string[];
  onAction: (a: Action) => void;
}) {
  const kinds = kindsForType(entityType).filter((k) => allowedKinds.includes(k));
  const [draft, setDraft] = useState({ kind: kinds[0] ?? "iban", value: "", label: "", bank: "", currency: "", isPrimary: false });
  const [editing, setEditing] = useState<{ id: number; label: string; bank: string; currency: string } | null>(null);
  const hint = codeTypeHint(draft.kind, draft.value, entityType);
  const groups = [...new Set([...kinds, ...requisites.map((r) => r.kind)])].filter((k) => requisites.some((r) => r.kind === k));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Requisites</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {groups.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
        {groups.map((k) => (
          <section key={k} aria-label={REQUISITE_LABEL[k] ?? k}>
            <h3 className="text-xs font-medium text-muted-foreground mb-1">{REQUISITE_LABEL[k] ?? k}</h3>
            <ul className="divide-y rounded-lg border">
              {requisites
                .filter((r) => r.kind === k)
                .sort((a, b) => Number(b.isActive) - Number(a.isActive) || Number(b.isPrimary) - Number(a.isPrimary))
                .map((r) => (
                  <li key={r.id} className={`flex flex-wrap items-center gap-2 p-2 ${r.isActive ? "" : "opacity-60"}`}>
                    <span className="font-mono break-all">{shown(r)}</span>
                    {r.label && <span>{r.label}</span>}
                    {r.bank && <span className="text-xs text-muted-foreground">{r.bank}</span>}
                    {r.currency && <Badge variant="outline">{r.currency}</Badge>}
                    {r.isPrimary && <Badge variant="secondary">Primary</Badge>}
                    {!r.isActive && <Badge variant="outline">Inactive</Badge>}
                    {editing?.id === r.id ? (
                      <span className="flex w-full flex-wrap items-center gap-1">
                        <Input className="h-7 w-36 text-xs" aria-label="Label" placeholder="Label" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
                        <Input className="h-7 w-28 text-xs" aria-label="Bank" placeholder="Bank" value={editing.bank} onChange={(e) => setEditing({ ...editing, bank: e.target.value })} />
                        <Input className="h-7 w-16 text-xs" aria-label="Currency" placeholder="UAH" value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value.toUpperCase() })} />
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            onAction({ title: "Save requisite details", confirm: "Save", body: { op: "identifiers", entityId, update: [{ id: r.id, label: editing.label.trim() || null, bank: editing.bank.trim() || null, currency: editing.currency.trim() || null }] } });
                            setEditing(null);
                          }}
                        >
                          Save…
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(null)}>Cancel</Button>
                      </span>
                    ) : (
                      <span className="ml-auto flex flex-wrap gap-1">
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing({ id: r.id, label: r.label ?? "", bank: r.bank ?? "", currency: r.currency ?? "" })}>
                          Edit
                        </Button>
                        {r.isActive && !r.isPrimary && (
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onAction({ title: "Make primary", confirm: "Save", body: { op: "identifiers", entityId, update: [{ id: r.id, isPrimary: true }] } })}>
                            Make primary
                          </Button>
                        )}
                        {r.isActive ? (
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onAction({ title: "Mark inactive", confirm: "Deactivate", body: { op: "identifiers", entityId, deactivate: [r.id] } })}>
                            Deactivate
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onAction({ title: "Reactivate", confirm: "Save", body: { op: "identifiers", entityId, update: [{ id: r.id, isActive: true }] } })}>
                            Reactivate
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => onAction({ title: "Remove requisite", confirm: "Remove", body: { op: "identifiers", entityId, remove: [r.id] } })}>
                          Remove
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        ))}
        <div className="space-y-2 rounded-md border p-2">
          <div className="flex flex-wrap gap-2">
            <select aria-label="Requisite kind" className="h-9 rounded-md border bg-background px-2 text-sm" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {kinds.map((k) => (
                <option key={k} value={k}>{REQUISITE_LABEL[k] ?? k}</option>
              ))}
            </select>
            <Input
              className="flex-1 min-w-48"
              aria-label="Requisite value"
              placeholder={draft.kind === "card_last4" ? "Last 4 digits (a full number is cut to 4)" : draft.kind === "tax_id" ? "10 digits" : draft.kind === "edrpou" ? "8 digits" : "Value"}
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-8 w-40" aria-label="New requisite label" placeholder="Label (optional)" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            <Input className="h-8 w-32" aria-label="New requisite bank" placeholder="Bank (optional)" value={draft.bank} onChange={(e) => setDraft({ ...draft, bank: e.target.value })} />
            <Input className="h-8 w-20" aria-label="New requisite currency" placeholder="UAH" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
            <label className="inline-flex items-center gap-1 text-xs">
              <input type="checkbox" checked={draft.isPrimary} onChange={(e) => setDraft({ ...draft, isPrimary: e.target.checked })} /> Primary
            </label>
            <Button
              size="sm"
              disabled={!draft.value.trim()}
              onClick={() => {
                onAction({
                  title: "Add requisite",
                  confirm: "Add",
                  body: {
                    op: "identifiers",
                    entityId,
                    add: [{ kind: draft.kind, value: draft.value.trim(), label: draft.label.trim() || null, bank: draft.bank.trim() || null, currency: draft.currency.trim() || null, isPrimary: draft.isPrimary }],
                  },
                });
                setDraft({ ...draft, value: "", label: "", bank: "", currency: "", isPrimary: false });
              }}
            >
              Add…
            </Button>
          </div>
          {hint && <p className="text-xs text-amber-700 dark:text-amber-300">{hint}</p>}
          <p className="text-xs text-muted-foreground">
            Stored encrypted. Cards keep only their last 4 digits; IBAN, ІПН and EDRPOU identify a payee, the last 4 digits of a card only hint at one.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
