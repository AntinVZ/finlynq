"use client";

/**
 * /settings/payees/review — AI review.
 *
 * Proposals an AI client (e.g. Claude over MCP: `manage_payees op=review` →
 * `op=propose`) submitted as drafts: canonical name, type, aliases,
 * requisites, its reason and confidence. Nothing has changed yet. Accept
 * (one or many — always previewed first: "renames N rows in …") or reject.
 * "Select ≥ threshold" picks the confident drafts but never the ones that
 * involve a private person or sole proprietor ("needs decision"). Accepted
 * drafts become one batch, undoable for 30 days from Payees → Changes.
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/components/actions/action-button";
import { ShortcutHelp } from "@/components/actions/shortcut-help";
import { useListKeyboard } from "@/components/actions/use-list-keyboard";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import { confidenceBadge, needsDecisionBadge } from "../_components/payee-ui";
import { PayeeTypeLabel } from "../_components/merchant-type-ui";
import { OpDialog, describeRows, type OpPreview } from "../_components/op-dialog";
import { useStudioT } from "../_components/i18n";

type Proposal = {
  id: number;
  canonical: string;
  type: string;
  entityId: number | null;
  aliases: Array<{ pattern: string; mode: string }>;
  identifiers: Array<{ kind: string; value: string }>;
  reason: string;
  confidence: number;
  needsDecision: boolean;
  notes: string[];
  status: string;
  createdAt: string;
};

export default function PayeeReviewPage() {
  const t = useStudioT();
  const { data, error, mutate } = useSWR<{ proposals: Proposal[] }>("/api/payees/proposals", jsonFetcher, { revalidateOnFocus: false });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [threshold, setThreshold] = useState(90);
  const [approving, setApproving] = useState<number[] | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const proposals = useMemo(() => data?.proposals ?? [], [data]);
  const eligible = useMemo(() => proposals.filter((p) => !p.needsDecision && p.confidence * 100 >= threshold && !p.notes.length), [proposals, threshold]);

  function toggle(id: number) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function reject(ids: number[]) {
    setBusy(true);
    const res = await fetch("/api/payees/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reject", ids }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setStatus(t("review.rejected", { n: ids.length }));
      setSelected(new Set());
      await mutate();
    } else setStatus(t("review.rejectFailed"));
  }

  const kb = useListKeyboard({ items: proposals, onConfirm: (p) => setApproving([p.id]), onReject: (p) => void reject([p.id]), enabled: !approving });

  async function approved(r: OpPreview) {
    setApproving(null);
    setSelected(new Set());
    setStatus(t("review.accepted", { rows: describeRows(r, t) }));
    await mutate();
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <Link href="/settings/payees" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="h-3 w-3" /> {t("page.title")}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight mt-1">{t("review.title")}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t("review.subtitle")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("review.proposals")}</CardTitle>
          <CardDescription>{t("review.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="inline-flex items-center gap-2">
              {t("settings.threshold")}
              <input type="range" min={50} max={99} value={threshold} aria-label={t("review.thresholdAria")} onChange={(e) => setThreshold(Number(e.target.value))} />
              <span className="tabular-nums w-10">{threshold}%</span>
            </label>
            <ActionButton intent="neutral" soft disabled={!eligible.length} onClick={() => setSelected(new Set(eligible.map((p) => p.id)))}>
              {t("review.selectAbove", { pct: threshold, n: eligible.length })}
            </ActionButton>
            <ActionButton intent="confirm" disabled={!selected.size || busy} onClick={() => setApproving([...selected])}>
              {t("review.acceptSelected")}{selected.size ? ` (${selected.size})` : ""}
            </ActionButton>
            <ActionButton intent="reject" soft disabled={!selected.size || busy} onClick={() => reject([...selected])}>
              {t("review.rejectSelected")}
            </ActionButton>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("review.selectNote")}{" "}
            <button type="button" className="hidden underline lg:inline" onClick={() => kb.setHelpOpen(true)}>
              {t("shortcuts.hint")}
            </button>
          </p>
          {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
          {error && <p className="text-sm text-destructive">{t("review.loadFailed")}</p>}
          {!data && !error ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("review.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {proposals.map((p, i) => (
                <li key={p.id} aria-current={kb.index === i || undefined} className={`rounded-lg border p-3 text-sm space-y-1.5 ${kb.index === i ? "ring-2 ring-action-open" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" aria-label={t("review.selectProposal", { name: p.canonical })} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    <span className="font-medium break-all">{p.canonical}</span>
                    <PayeeTypeLabel className="text-xs text-muted-foreground" type={p.type} />
                    {confidenceBadge(p.confidence, t)}
                    {p.needsDecision && needsDecisionBadge(t("review.personTitle"), t)}
                    {p.entityId != null && (
                      <Link href={`/settings/payees/${p.entityId}`} className="text-xs hover:underline">
                        {t("review.extends", { id: p.entityId })}
                      </Link>
                    )}
                    <span className="ms-auto flex gap-1">
                      <ActionButton intent="confirm" className="h-7 text-xs" shortcut={kb.index === i ? "Enter" : undefined} onClick={() => setApproving([p.id])}>
                        {t("review.acceptEllipsis")}
                      </ActionButton>
                      <ActionButton intent="reject" soft className="h-7 text-xs" shortcut={kb.index === i ? "⌫" : undefined} disabled={busy} onClick={() => reject([p.id])}>
                        {t("review.reject")}
                      </ActionButton>
                    </span>
                  </div>
                  {p.reason && <p className="text-xs text-muted-foreground">{p.reason}</p>}
                  {p.aliases.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {p.aliases.map((a) => (
                        <Badge key={`${a.mode}|${a.pattern}`} variant="secondary" className="font-normal">
                          {a.pattern}
                          {a.mode !== "exact" && <span className="ms-1 text-muted-foreground">({a.mode})</span>}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {p.identifiers.length > 0 && (
                    <p className="text-xs text-muted-foreground">{t("review.requisites", { list: p.identifiers.map((i) => `${i.kind} ${i.kind === "card_last4" ? `•••• ${i.value}` : i.value}`).join(", ") })}</p>
                  )}
                  {p.notes.map((n) => (
                    <p key={n} className="text-xs text-amber-600 dark:text-amber-400">{n}</p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {approving && (
        <OpDialog
          title={t("review.acceptTitle", { n: approving.length })}
          body={{ action: "approve", ids: approving }}
          endpoint="/api/payees/proposals"
          confirmLabel={t("review.accept")}
          onClose={() => setApproving(null)}
          onDone={approved}
        >
          {proposals.some((p) => approving.includes(p.id) && p.needsDecision) && (
            <p className="text-xs text-action-reject-text">{t("review.personWarning")}</p>
          )}
        </OpDialog>
      )}
      <ShortcutHelp open={kb.helpOpen} onOpenChange={kb.setHelpOpen} />
    </div>
  );
}
