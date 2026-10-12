"use client";

/**
 * Export / import the payee dictionary (GET / POST /api/payees/dictionary).
 * Export holds only shareable data (names, aliases, types, public company
 * ids). Import is previewed entry by entry; a conflict needs a decision
 * (skip, create anyway is refused, or merge into one of the candidates)
 * before the import can run as one undoable batch.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { StudioTextKey } from "@/lib/payees/i18n";
import { PayeeTypeLabel } from "./merchant-type-ui";
import { useStudioT } from "./i18n";

type PlanItem = {
  index: number;
  name: string;
  type: string;
  action: "create" | "merge" | "skip" | "conflict" | "unchanged";
  target: { id: number; name: string } | null;
  candidates: Array<{ id: number; name: string }>;
  newAliases: Array<{ pattern: string; mode: string }>;
  newIdentifiers: Array<{ kind: string; value: string }>;
  newWebsite?: string | null;
  newMerchantType?: { group: string; name: string } | null;
  note: string | null;
};
type PlanResponse = { plan: PlanItem[]; errors: Array<{ index: number; error: string }>; counts: Record<string, number>; batchId?: number | null; error?: string };

const ACTION_LABEL: Record<PlanItem["action"], StudioTextKey> = {
  create: "dictionary.action.create",
  merge: "dictionary.action.merge",
  unchanged: "dictionary.action.unchanged",
  skip: "dictionary.action.skip",
  conflict: "dictionary.action.conflict",
};

export function DictionaryCard({ onImported }: { onImported: () => void }) {
  const t = useStudioT();
  const [content, setContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(text: string, res: Record<string, string>, dryRun: boolean) {
    setBusy(true);
    setError("");
    const r = await fetch("/api/payees/dictionary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, resolutions: res, dryRun }),
    }).catch(() => null);
    const json = (r ? await r.json().catch(() => null) : null) as PlanResponse | null;
    setBusy(false);
    if (json?.plan) setPlan(json);
    if (!r?.ok) {
      setError(json?.error ?? t("dictionary.importFailed"));
      return null;
    }
    return json;
  }

  async function onFile(f: File | undefined) {
    setStatus("");
    setPlan(null);
    setResolutions({});
    if (!f) return;
    const text = await f.text();
    setContent(text);
    setFileName(f.name);
    await send(text, {}, true);
  }

  async function decide(index: number, value: string) {
    const next = { ...resolutions, [String(index)]: value };
    if (!value) delete next[String(index)];
    setResolutions(next);
    if (content) await send(content, next, true);
  }

  async function commit() {
    if (!content) return;
    const res = await send(content, resolutions, false);
    if (res) {
      setStatus(`${t("dictionary.imported", { created: res.counts.create ?? 0, merged: res.counts.merge ?? 0 })}${res.batchId ? ` ${t("dictionary.undoHint", { id: res.batchId })}` : ""}`);
      setPlan(null);
      setContent(null);
      onImported();
    }
  }

  const conflicts = plan?.plan.filter((p) => p.action === "conflict").length ?? 0;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">{t("dictionary.intro")}</p>
      <div className="flex flex-wrap gap-2">
        <a href="/api/payees/dictionary?format=json" download>
          <Button size="sm" variant="outline">{t("dictionary.exportJson")}</Button>
        </a>
        <a href="/api/payees/dictionary?format=yaml" download>
          <Button size="sm" variant="outline">{t("dictionary.exportYaml")}</Button>
        </a>
        <label className="inline-flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("dictionary.importLabel")}</span>
          <input type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" aria-label={t("dictionary.file")} onChange={(e) => onFile(e.target.files?.[0])} className="text-xs" />
        </label>
      </div>
      {status && <p className="text-emerald-600 dark:text-emerald-400">{status}</p>}
      {error && <p className="text-destructive">{error}</p>}
      {plan && (
        <div className="space-y-2 rounded-md border p-3">
          <p>
            {fileName}: {t("dictionary.planCounts", { created: plan.counts.create ?? 0, merged: plan.counts.merge ?? 0, unchanged: plan.counts.unchanged ?? 0, skipped: plan.counts.skip ?? 0 })}
            {" · "}
            <span className={conflicts ? "text-amber-600 dark:text-amber-400" : undefined}>{t("dictionary.planConflicts", { n: conflicts })}</span>
          </p>
          {plan.errors.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("dictionary.unreadable", { list: plan.errors.map((e) => `#${e.index + 1} (${e.error})`).join("; ") })}
            </p>
          )}
          <ul className="max-h-72 overflow-y-auto divide-y text-xs">
            {plan.plan
              .filter((p) => p.action !== "unchanged")
              .map((p) => (
                <li key={p.index} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="font-medium break-all">{p.name}</span>
                  <PayeeTypeLabel className="text-muted-foreground" merchantType={p.newMerchantType} type={p.type} />
                  <span className={p.action === "conflict" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
                    {t(ACTION_LABEL[p.action])}
                    {p.target ? ` “${p.target.name}”` : ""}
                    {p.newAliases.length ? ` · ${t("dictionary.newAliases", { n: p.newAliases.length })}` : ""}
                    {p.newWebsite ? ` · ${t("dictionary.newWebsite", { site: p.newWebsite.replace(/^https:\/\//, "") })}` : ""}
                  </span>
                  {(p.action === "conflict" || resolutions[String(p.index)]) && (
                    <select
                      aria-label={t("dictionary.decisionFor", { name: p.name })}
                      className="ml-auto h-7 rounded-md border bg-background px-1"
                      value={resolutions[String(p.index)] ?? ""}
                      onChange={(e) => decide(p.index, e.target.value)}
                    >
                      <option value="">{t("dictionary.decide")}</option>
                      <option value="skip">{t("dictionary.skip")}</option>
                      {p.candidates.map((c) => (
                        <option key={c.id} value={`merge:${c.id}`}>{t("dictionary.addTo", { name: c.name })}</option>
                      ))}
                    </select>
                  )}
                  {p.note && <span className="basis-full text-muted-foreground">{p.note}</span>}
                </li>
              ))}
          </ul>
          <div className="flex justify-end">
            <Button size="sm" disabled={busy || conflicts > 0 || !((plan.counts.create ?? 0) + (plan.counts.merge ?? 0))} onClick={commit}>
              {busy ? t("common.working") : t("dictionary.import")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
