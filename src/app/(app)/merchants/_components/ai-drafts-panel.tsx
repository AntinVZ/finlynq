"use client";

/**
 * AI drafts (P8 stage 9) — the Merchants queue tab and /merchants/review.
 *
 * Proposals an AI client (e.g. Claude over MCP: `manage_payees op=review` →
 * `op=propose`) submitted as drafts: canonical name, type, aliases,
 * requisites, its reason and confidence. Nothing has changed yet. Accept
 * (one or many — always previewed first: "renames N rows in …") or reject.
 * "Select ≥ threshold" picks the confident drafts but never the exceptions:
 * a private person or sole proprietor ("needs decision"), a draft with a
 * warning, a name of type words only, or a payment channel. Accepted drafts become one batch, undoable for 30 days.
 *
 * Above the list: «Скопіювати запит для Claude» and ready recipes — texts
 * the person pastes into Claude; the server never calls a model.
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Copy, Check, Sparkles } from "lucide-react";
import { jsonFetcher } from "@/lib/swr";
import { ActionButton } from "@/components/actions/action-button";
import { ShortcutHelp } from "@/components/actions/shortcut-help";
import { useListKeyboard } from "@/components/actions/use-list-keyboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { confidenceBadge, needsDecisionBadge } from "./payee-ui";
import { PayeeTypeLabel } from "./merchant-type-ui";
import { OpDialog, describeRows, type OpPreview } from "./op-dialog";
import { useStudioT } from "./i18n";

export type Proposal = {
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
  source?: string;
  exception?: "type_word" | "channel";
  createdAt: string;
};

/** Ready prompts: title + text keys, literal so lint:i18n can see them. */
export const AI_RECIPES = [
  { id: "review", title: "aiRecipes.review.title", text: "aiRecipes.review.text" },
  { id: "duplicates", title: "aiRecipes.duplicates.title", text: "aiRecipes.duplicates.text" },
  { id: "types", title: "aiRecipes.types.title", text: "aiRecipes.types.text" },
  { id: "import", title: "aiRecipes.import.title", text: "aiRecipes.import.text" },
  { id: "sites", title: "aiRecipes.sites.title", text: "aiRecipes.sites.text" },
] as const;

/** An exception "Select ≥ threshold" never picks: a person / ФОП, a warning, only type words, a channel. */
export function isDraftException(p: Proposal): boolean {
  return p.needsDecision || p.notes.length > 0 || p.exception != null;
}

/** Drafts that "Select ≥ threshold" may pick: confident and with no exception. */
export function eligibleDrafts(proposals: readonly Proposal[], thresholdPct: number): Proposal[] {
  return proposals.filter((p) => !isDraftException(p) && p.confidence * 100 >= thresholdPct);
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      data-testid={testId}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="me-1 h-3 w-3" /> : <Copy className="me-1 h-3 w-3" />}
      {copied ? t("aiRecipes.copied") : label}
    </Button>
  );
}

export function AiRecipes() {
  const t = useT();
  return (
    <section className="rounded-lg border p-3 space-y-2 text-sm" aria-label={t("aiRecipes.title")}>
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t("aiRecipes.title")}</span>
        <CopyButton text={t("aiRecipes.review.text")} label={t("aiRecipes.copyMain")} testId="copy-claude-prompt" />
      </div>
      <p className="text-xs text-muted-foreground">{t("aiRecipes.note")}</p>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t("aiRecipes.more")}</summary>
        <ul className="mt-2 space-y-2">
          {AI_RECIPES.map((r) => (
            <li key={r.id} className="rounded-md border p-2 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-xs">{t(r.title)}</span>
                <span className="ms-auto">
                  <CopyButton text={t(r.text)} label={t("aiRecipes.copy")} />
                </span>
              </div>
              <p className="text-xs text-muted-foreground whitespace-pre-line">{t(r.text)}</p>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export function AiDraftsPanel({ onChanged }: { onChanged?: () => void }) {
  const t = useStudioT();
  const { data, error, mutate } = useSWR<{ proposals: Proposal[] }>("/api/payees/proposals", jsonFetcher, { revalidateOnFocus: false });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [threshold, setThreshold] = useState(90);
  const [approving, setApproving] = useState<number[] | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const proposals = useMemo(() => (Array.isArray(data?.proposals) ? data!.proposals : []), [data]);
  const eligible = useMemo(() => eligibleDrafts(proposals, threshold), [proposals, threshold]);
  const exceptions = proposals.filter((p) => p.confidence * 100 >= threshold && isDraftException(p)).length;

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
      onChanged?.();
    } else setStatus(t("review.rejectFailed"));
  }

  const kb = useListKeyboard({ items: proposals, onConfirm: (p) => setApproving([p.id]), onReject: (p) => void reject([p.id]), enabled: !approving });

  async function approved(r: OpPreview) {
    setApproving(null);
    setSelected(new Set());
    setStatus(t("review.accepted", { rows: describeRows(r, t) }));
    await mutate();
    onChanged?.();
  }

  return (
    <div className="space-y-3">
      <AiRecipes />
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
        {t("review.selectNote")}
        {exceptions > 0 && <> {t("aiDrafts.exceptions", { n: exceptions })}</>}{" "}
        <button type="button" className="hidden underline lg:inline" onClick={() => kb.setHelpOpen(true)}>
          {t("shortcuts.hint")}
        </button>
      </p>
      {status && <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">{status}</p>}
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
                {(p.source ?? "mcp") === "mcp" && (
                  <Badge variant="outline" className="gap-1 font-normal" data-testid="claude-badge" title={t("aiDrafts.badgeTitle")}>
                    <Sparkles className="h-3 w-3" aria-hidden />
                    {t("aiDrafts.badge")}
                  </Badge>
                )}
                {confidenceBadge(p.confidence, t)}
                {p.needsDecision && needsDecisionBadge(t("review.personTitle"), t)}
                {p.entityId != null && (
                  <Link href={`/merchants/${p.entityId}`} className="text-xs hover:underline">
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
              {p.exception && (
                <p className="text-xs text-amber-600 dark:text-amber-400">{p.exception === "channel" ? t("aiDrafts.exceptionChannel") : t("aiDrafts.exceptionTypeWord")}</p>
              )}
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
                <p className="text-xs text-muted-foreground">{t("review.requisites", { list: p.identifiers.map((x) => `${x.kind} ${x.kind === "card_last4" ? `•••• ${x.value}` : x.value}`).join(", ") })}</p>
              )}
              {p.notes.map((n) => (
                <p key={n} className="text-xs text-amber-600 dark:text-amber-400">{n}</p>
              ))}
            </li>
          ))}
        </ul>
      )}

      {approving && (
        <OpDialog
          title={t("review.acceptTitle", { n: approving.length })}
          body={{ action: "approve", ids: approving }}
          endpoint="/api/payees/proposals"
          confirmLabel={t("review.accept")}
          onClose={() => setApproving(null)}
          onDone={approved}
        >
          {proposals.some((p) => approving.includes(p.id) && p.needsDecision) && <p className="text-xs text-action-reject-text">{t("review.personWarning")}</p>}
        </OpDialog>
      )}
      <ShortcutHelp open={kb.helpOpen} onOpenChange={kb.setHelpOpen} />
    </div>
  );
}
