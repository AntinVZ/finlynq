"use client";

/**
 * "Why not clustered?" — two payees in, the clustering's view of them out
 * (GET /api/payees/explain): matching keys, cores, the 4-letter block, type
 * guesses, the score, and the rule that joined or kept them apart.
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StudioTextKey } from "@/lib/payees/i18n";
import { typeLabel } from "./payee-ui";
import { useStudioT } from "./i18n";

type Side = {
  payee: string;
  key: string;
  core: string;
  block: string;
  brandLine?: string;
  bankOperation?: string | null;
  type: { type: string; reason: string; isPerson: boolean };
  entity: { id: number; name: string } | null;
};
type Explanation = { a: Side; b: Side; sameKey: boolean; score: { confidence: number; reason: string } | null; verdict: string; reasons: string[] };

const VERDICT: Record<string, StudioTextKey> = {
  same_name: "explain.verdict.same_name",
  clustered: "explain.verdict.clustered",
  separate: "explain.verdict.separate",
  settled: "explain.verdict.settled",
};

export function ExplainDialog({ initialA = "", initialB = "", onClose }: { initialA?: string; initialB?: string; onClose: () => void }) {
  const t = useStudioT();
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(initialB);
  const [result, setResult] = useState<Explanation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/payees/explain?a=${encodeURIComponent(a.trim())}&b=${encodeURIComponent(b.trim())}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) setError(data?.error ?? t("explain.failed"));
      else setResult(data as Explanation);
    } finally {
      setBusy(false);
    }
  }

  const side = (label: string, s: Side) => (
    <div className="rounded-md border p-2 text-xs space-y-0.5 min-w-0">
      <p className="font-medium text-sm break-all">{label}: {s.payee}</p>
      <p>{t("explain.key")} <code className="break-all">{s.key || "—"}</code></p>
      <p>{t("explain.core")} <code className="break-all">{s.core || "—"}</code> · {t("explain.block")} <code>{s.block || "—"}</code></p>
      {s.brandLine && <p className="break-words">{s.brandLine}</p>}
      {s.bankOperation && <p>{t("explain.bankOperation", { op: s.bankOperation })}</p>}
      <p>{t("explain.type")} {typeLabel(s.type.type, t)} <span className="text-muted-foreground">({s.type.reason})</span></p>
      <p>{t("explain.directory")} {s.entity ? `${s.entity.name} (#${s.entity.id})` : t("explain.notInDirectory")}</p>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("explain.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input aria-label={t("explain.first")} placeholder={t("explain.first")} value={a} onChange={(e) => setA(e.target.value)} />
            <Input aria-label={t("explain.second")} placeholder={t("explain.second")} value={b} onChange={(e) => setB(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button size="sm" disabled={busy || !a.trim() || !b.trim()} onClick={run}>
              {t("explain.run")}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && (
            <div className="space-y-2">
              <p className="font-medium">
                {VERDICT[result.verdict] ? t(VERDICT[result.verdict]) : result.verdict}
                {result.score ? ` · ${t("explain.score", { pct: Math.round(result.score.confidence * 100) })}` : ""}
              </p>
              <ul className="list-disc pl-5 text-xs space-y-1">
                {result.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="grid gap-2 sm:grid-cols-2">
                {side("A", result.a)}
                {side("B", result.b)}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
