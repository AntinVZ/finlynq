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
import { ActionButton } from "@/components/actions/action-button";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/i18n/format-current";
import { confidenceBadge, needsDecisionBadge } from "./payee-ui";
import { PayeeTypeLabel } from "./merchant-type-ui";
import { OpDialog, type OpPreview } from "./op-dialog";
import { useStudioT } from "./i18n";

export type LookalikeCandidate = {
  key: string;
  name: string;
  spellings: Array<{ spelling: string; count: number }>;
  count: number;
  total: number;
  lastDate: string | null;
  entity: { id: number; name: string; type: string; merchantType?: { group: string; name: string } | null };
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
  const t = useStudioT();
  const { data, error, mutate, isValidating } = useSWR<Report>("/api/payees/lookalikes", jsonFetcher, { revalidateOnFocus: false });
  const [action, setAction] = useState<Action | null>(null);
  const [rest, setRest] = useState<Record<string, { text: string; target: "tag" | "note" }>>({});
  const [status, setStatus] = useState("");

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/payees/lookalikes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) setStatus(t("lookalikes.saveFailed"));
    await mutate();
    onChanged();
  }

  async function done(r: OpPreview) {
    setAction(null);
    setStatus(t("lookalikes.saved", { n: r.rows.total }));
    await mutate();
    onChanged();
  }

  if (error) return <p className="text-sm text-destructive">{t("lookalikes.loadFailed")}</p>;
  const cur = data?.currency ?? "USD";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={isValidating} onClick={() => mutate()}>
          {isValidating ? t("common.checking") : t("lookalikes.check")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("lookalikes.intro")}</span>
      </div>
      {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
      {!data ? (
        <p className="text-sm text-muted-foreground">{t("common.checking")}</p>
      ) : (
        <>
          {data.unrenamed.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("lookalikes.unrenamed")}</h3>
              <ul className="divide-y rounded-lg border">
                {data.unrenamed.map((u) => (
                  <li key={u.entityId} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                    <span className="break-all">
                      {u.spellings.map((s) => `“${s.spelling}” × ${s.count}`).join(", ")} → <Link href={`/settings/payees/${u.entityId}`} className="font-medium hover:underline">{u.entityName}</Link>
                    </span>
                    <ActionButton
                      intent="confirm"
                      soft
                      className="ms-auto h-7 text-xs"
                      onClick={() => setAction({ title: t("common.renameTo", { name: u.entityName }), body: { op: "apply", entityIds: [u.entityId] }, confirm: t("common.rename") })}
                    >
                      {t("common.apply")}
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("lookalikes.empty")}{data.rejectedHidden ? ` ${t("lookalikes.hidden", { n: data.rejectedHidden })}` : ""}</p>
          ) : (
            <ul className="space-y-2">
              {data.candidates.map((c) => {
                const r = rest[c.key] ?? { text: c.remainder ?? "", target: "tag" as const };
                return (
                  <li key={c.key} className="rounded-lg border p-3 text-sm space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all">{c.name}</span>
                      <span className="text-muted-foreground">{t("lookalikes.looksLike")}</span>
                      <Link href={`/settings/payees/${c.entity.id}`} className="font-medium hover:underline break-all">{c.entity.name}</Link>
                      <PayeeTypeLabel className="text-xs text-muted-foreground" merchantType={c.entity.merchantType} type={c.entity.type} />
                      {confidenceBadge(c.confidence, t)}
                      {c.needsDecision && needsDecisionBadge(c.decisionReason, t)}
                      <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                        {t("common.tx", { n: c.count })} · {formatCurrency(c.total, cur)}
                        {c.lastDate ? ` · ${t("common.last", { date: formatDate(c.lastDate) })}` : ""}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("lookalikes.why", { reason: c.reason, alias: c.matchedAlias })}
                      {c.alternatives.length > 0 && <> {t("lookalikes.alsoLike", { list: c.alternatives.map((a) => `${a.name} ${Math.round(a.confidence * 100)}%`).join(", ") })}</>}
                      {c.decisionReason && <span className="block text-action-reject-text">{c.decisionReason}</span>}
                    </p>
                    {c.spellings.length > 1 && (
                      <div className="flex flex-wrap gap-1.5">
                        {c.spellings.map((s) => (
                          <Badge key={s.spelling} variant="secondary" className="font-normal">{s.spelling} <span className="ms-1 text-muted-foreground">× {s.count}</span></Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <ActionButton
                        intent="confirm"
                        soft
                        className="h-7 text-xs"
                        onClick={() =>
                          setAction({
                            title: t("lookalikes.sameTitle", { name: c.name, entity: c.entity.name }),
                            body: { op: "alias_add", entityId: c.entity.id, aliases: c.spellings.map((s) => ({ pattern: s.spelling, mode: "exact" })) },
                            confirm: t("lookalikes.same"),
                          })
                        }
                      >
                        {t("lookalikes.same")}
                      </ActionButton>
                      <span className="inline-flex flex-wrap items-center gap-1 rounded-md border px-1.5 py-1">
                        <Input
                          aria-label={t("lookalikes.keepFrom", { name: c.name })}
                          className="h-7 w-44 text-xs"
                          placeholder={t("lookalikes.keep")}
                          value={r.text}
                          onChange={(e) => setRest({ ...rest, [c.key]: { ...r, text: e.target.value } })}
                        />
                        <select
                          aria-label={t("lookalikes.keepIn")}
                          className="h-7 rounded-md border bg-background px-1 text-xs"
                          value={r.target}
                          onChange={(e) => setRest({ ...rest, [c.key]: { ...r, target: e.target.value as "tag" | "note" } })}
                        >
                          <option value="tag">{t("lookalikes.asTag")}</option>
                          <option value="note">{t("lookalikes.inNote")}</option>
                        </select>
                        <ActionButton
                          intent="neutral"
                          soft
                          className="h-7 text-xs"
                          disabled={!r.text.trim()}
                          onClick={() =>
                            setAction({
                              title: t(r.target === "tag" ? "lookalikes.moveTitleTag" : "lookalikes.moveTitleNote", { entity: c.entity.name, text: r.text.trim() }),
                              body: { op: "move_remainder", entityId: c.entity.id, payees: c.spellings.map((s) => s.spelling), remainder: r.text.trim(), target: r.target },
                              confirm: t("lookalikes.move"),
                              note: t(r.target === "tag" ? "lookalikes.moveNoteTag" : "lookalikes.moveNoteNote", { entity: c.entity.name, text: r.text.trim() }),
                            })
                          }
                        >
                          {t("lookalikes.sameKeepRest")}
                        </ActionButton>
                      </span>
                      <ActionButton intent="reject" soft className="h-7 text-xs" onClick={() => post({ action: "reject", payee: c.name, entityId: c.entity.id })}>
                        {t("lookalikes.different")}
                      </ActionButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {data.rejections.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t("lookalikes.answered", { n: data.rejections.length })}</summary>
              <ul className="mt-2 divide-y rounded-lg border">
                {data.rejections.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 p-2 text-xs">
                    <span className="break-all">{r.payee ?? t("lookalikes.goneSpelling")} ≠ {r.entityName ?? `#${r.entityId}`}</span>
                    <Button size="sm" variant="ghost" className="ms-auto h-6 text-xs" onClick={() => post({ action: "unreject", id: r.id })}>
                      {t("common.cancel")}
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
