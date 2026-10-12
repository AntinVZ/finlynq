"use client";

/**
 * Look-alikes (Payee Studio P5b): spellings that are not in the directory but
 * look like one of its entries (GET /api/payees/lookalikes — computed only
 * when this tab is opened or "Check for new look-alikes" is pressed).
 *
 * Three answers per suggestion:
 *   1. Same payee — the spellings become aliases of the entry (alias_add,
 *      previewed, renames the stored rows);
 *   2. Same payee, move the rest to a tag or note — the payee becomes the
 *      entry's name and the remainder (`компенсація житла`, editable) goes to
 *      the tags (default) or the note (move_remainder, previewed);
 *   3. Different payee — remembered, not suggested again (cancellable below).
 * People / sole proprietors are marked "Needs decision" and never applied
 * automatically. "Belongs to an entry, not renamed yet" lists rows an alias
 * already resolves but that still carry another spelling (Apply).
 */

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import { confidenceBadge, needsDecisionBadge, typeLabel } from "./payee-ui";
import { OpDialog, type OpPreview } from "./op-dialog";

export type LookalikeCandidate = {
  key: string;
  name: string;
  spellings: Array<{ spelling: string; count: number }>;
  count: number;
  total: number;
  lastDate: string | null;
  entity: { id: number; name: string; type: string };
  confidence: number;
  reason: string;
  matchedAlias: string;
  needsDecision: boolean;
  decisionReason: string | null;
  remainder: string | null;
  alternatives: Array<{ id: number; name: string; confidence: number }>;
};
type Report = {
  candidates: LookalikeCandidate[];
  unrenamed: Array<{ entityId: number; entityName: string; spellings: Array<{ spelling: string; count: number }>; rows: number }>;
  rejections: Array<{ id: number; entityId: number; entityName: string | null; payee: string | null; createdAt: string }>;
  rejectedHidden: number;
  currency: string;
};

type Action = { title: string; body: Record<string, unknown>; confirm: string; note?: string };

export function LookalikesPanel({ onChanged }: { onChanged: () => void }) {
  const { data, error, mutate, isValidating } = useSWR<Report>("/api/payees/lookalikes", jsonFetcher, { revalidateOnFocus: false });
  const [action, setAction] = useState<Action | null>(null);
  const [rest, setRest] = useState<Record<string, { text: string; target: "tag" | "note" }>>({});
  const [status, setStatus] = useState("");

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/payees/lookalikes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) setStatus("Couldn't save that answer.");
    await mutate();
    onChanged();
  }

  async function done(r: OpPreview) {
    setAction(null);
    setStatus(`Saved. ${r.rows.total} row(s) changed.`);
    await mutate();
    onChanged();
  }

  if (error) return <p className="text-sm text-destructive">Couldn&apos;t check look-alikes.</p>;
  const cur = data?.currency ?? "USD";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={isValidating} onClick={() => mutate()}>
          {isValidating ? "Checking…" : "Check for new look-alikes"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Payees not in the directory that look like one of its entries. Nothing changes until you pick an answer.
        </span>
      </div>
      {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
      {!data ? (
        <p className="text-sm text-muted-foreground">Checking…</p>
      ) : (
        <>
          {data.unrenamed.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Belongs to an entry, not renamed yet</h3>
              <ul className="divide-y rounded-lg border">
                {data.unrenamed.map((u) => (
                  <li key={u.entityId} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                    <span className="break-all">
                      {u.spellings.map((s) => `“${s.spelling}” × ${s.count}`).join(", ")} → <Link href={`/settings/payees/${u.entityId}`} className="font-medium hover:underline">{u.entityName}</Link>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7 text-xs"
                      onClick={() => setAction({ title: `Rename to “${u.entityName}”`, body: { op: "apply", entityIds: [u.entityId] }, confirm: "Rename" })}
                    >
                      Apply
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No new look-alikes.{data.rejectedHidden ? ` (${data.rejectedHidden} hidden by your earlier answers.)` : ""}</p>
          ) : (
            <ul className="space-y-2">
              {data.candidates.map((c) => {
                const r = rest[c.key] ?? { text: c.remainder ?? "", target: "tag" as const };
                return (
                  <li key={c.key} className="rounded-lg border p-3 text-sm space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{c.name}</span>
                      <span className="text-muted-foreground">looks like</span>
                      <Link href={`/settings/payees/${c.entity.id}`} className="font-medium hover:underline break-all">{c.entity.name}</Link>
                      <span className="text-xs text-muted-foreground">{typeLabel(c.entity.type)}</span>
                      {confidenceBadge(c.confidence)}
                      {c.needsDecision && needsDecisionBadge(c.decisionReason)}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {c.count} tx · {formatCurrency(c.total, cur)}
                        {c.lastDate ? ` · last ${c.lastDate}` : ""}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Why: {c.reason} (like “{c.matchedAlias}”).
                      {c.alternatives.length > 0 && <> Also like: {c.alternatives.map((a) => `${a.name} ${Math.round(a.confidence * 100)}%`).join(", ")}.</>}
                      {c.decisionReason && <span className="block text-rose-700 dark:text-rose-300">{c.decisionReason}</span>}
                    </p>
                    {c.spellings.length > 1 && (
                      <div className="flex flex-wrap gap-1.5">
                        {c.spellings.map((s) => (
                          <Badge key={s.spelling} variant="secondary" className="font-normal">{s.spelling} <span className="ml-1 text-muted-foreground">× {s.count}</span></Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() =>
                          setAction({
                            title: `“${c.name}” is ${c.entity.name}`,
                            body: { op: "alias_add", entityId: c.entity.id, aliases: c.spellings.map((s) => ({ pattern: s.spelling, mode: "exact" })) },
                            confirm: "Same payee",
                          })
                        }
                      >
                        Same payee
                      </Button>
                      <span className="inline-flex flex-wrap items-center gap-1 rounded-md border px-1.5 py-1">
                        <Input
                          aria-label={`Text to keep from ${c.name}`}
                          className="h-7 w-44 text-xs"
                          placeholder="Text to keep"
                          value={r.text}
                          onChange={(e) => setRest({ ...rest, [c.key]: { ...r, text: e.target.value } })}
                        />
                        <select
                          aria-label="Keep it in"
                          className="h-7 rounded-md border bg-background px-1 text-xs"
                          value={r.target}
                          onChange={(e) => setRest({ ...rest, [c.key]: { ...r, target: e.target.value as "tag" | "note" } })}
                        >
                          <option value="tag">as a tag</option>
                          <option value="note">in the note</option>
                        </select>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={!r.text.trim()}
                          onClick={() =>
                            setAction({
                              title: `Payee → “${c.entity.name}”, “${r.text.trim()}” → ${r.target === "tag" ? "tag" : "note"}`,
                              body: { op: "move_remainder", entityId: c.entity.id, payees: c.spellings.map((s) => s.spelling), remainder: r.text.trim(), target: r.target },
                              confirm: "Move",
                              note: `Every transaction with this spelling gets the payee “${c.entity.name}” and keeps “${r.text.trim()}” ${r.target === "tag" ? "as a tag" : "in its note"}.`,
                            })
                          }
                        >
                          Same payee, keep the rest
                        </Button>
                      </span>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => post({ action: "reject", payee: c.name, entityId: c.entity.id })}>
                        Different payee
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {data.rejections.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground">Answered “Different payee” ({data.rejections.length})</summary>
              <ul className="mt-2 divide-y rounded-lg border">
                {data.rejections.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 p-2 text-xs">
                    <span className="break-all">{r.payee ?? "(spelling no longer among your payees)"} ≠ {r.entityName ?? `#${r.entityId}`}</span>
                    <Button size="sm" variant="ghost" className="ml-auto h-6 text-xs" onClick={() => post({ action: "unreject", id: r.id })}>
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {action && (
        <OpDialog title={action.title} body={action.body} confirmLabel={action.confirm} onClose={() => setAction(null)} onDone={done}>
          {action.note && <p className="text-xs text-muted-foreground">{action.note}</p>}
        </OpDialog>
      )}
    </div>
  );
}
