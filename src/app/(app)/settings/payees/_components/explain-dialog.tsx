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
import { typeLabel } from "./payee-ui";

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

const VERDICT: Record<string, string> = {
  same_name: "One name — shown as one row",
  clustered: "Clustered — offered for merging",
  separate: "Kept apart",
  settled: "Already one directory entry",
};

export function ExplainDialog({ initialA = "", initialB = "", onClose }: { initialA?: string; initialB?: string; onClose: () => void }) {
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
      if (!res.ok) setError(data?.error ?? "Couldn't explain.");
      else setResult(data as Explanation);
    } finally {
      setBusy(false);
    }
  }

  const side = (label: string, s: Side) => (
    <div className="rounded-md border p-2 text-xs space-y-0.5 min-w-0">
      <p className="font-medium text-sm break-all">{label}: {s.payee}</p>
      <p>Key: <code className="break-all">{s.key || "—"}</code></p>
      <p>Core: <code className="break-all">{s.core || "—"}</code> · block <code>{s.block || "—"}</code></p>
      {s.brandLine && <p className="break-words">{s.brandLine}</p>}
      {s.bankOperation && <p>Банківська операція («{s.bankOperation}»)</p>}
      <p>Type: {typeLabel(s.type.type)} <span className="text-muted-foreground">({s.type.reason})</span></p>
      <p>Directory: {s.entity ? `${s.entity.name} (#${s.entity.id})` : "not in the directory"}</p>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Why (not) clustered?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input aria-label="First payee" placeholder="First payee" value={a} onChange={(e) => setA(e.target.value)} />
            <Input aria-label="Second payee" placeholder="Second payee" value={b} onChange={(e) => setB(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button size="sm" disabled={busy || !a.trim() || !b.trim()} onClick={run}>
              Explain
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && (
            <div className="space-y-2">
              <p className="font-medium">
                {VERDICT[result.verdict] ?? result.verdict}
                {result.score ? ` · score ${Math.round(result.score.confidence * 100)}%` : ""}
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
