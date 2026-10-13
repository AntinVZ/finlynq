"use client";

/**
 * The cost-basis method (2026-10-13): simple average, or advanced lot
 * allocation. One explanation, shown in two places:
 *
 *   <CostBasisSetting />  the choice itself, on Settings → Investments
 *   <CostBasisNote />     a one-line reference on the Portfolio page that
 *                         opens the same explanation and links to the setting
 *
 * Lots are recorded for everyone on every trade either way; the setting only
 * decides which figures are shown, so switching never changes a transaction
 * and switching back restores any matching the user chose.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parseSaveError } from "@/lib/save-error";

type Status = { enabled: boolean; positions: number; withoutLots: number; mismatched: number };

export const COST_BASIS_SETTINGS_HREF = "/settings/investments#cost-basis";

const METHODS = [
  {
    enabled: false,
    name: "Simple",
    summary: "The average price of every purchase, times the shares you hold.",
  },
  {
    enabled: true,
    name: "Advanced lot allocation",
    summary: "Each sale is matched to specific purchases, and you can change the matching.",
  },
] as const;

/** Read the user's method. `null` while loading or if the request fails. */
function useCostBasisStatus(): [Status | null, (s: Status) => void] {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/lot-allocation")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.data) setStatus(j.data as Status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return [status, setStatus];
}

/** What the two methods are, with one worked example. */
export function CostBasisExplainer() {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="font-medium">Simple (the default)</p>
        <p className="text-muted-foreground">
          Cost basis is the average price of every purchase you ever made in a holding, multiplied by
          the shares you still hold. It is easy to follow, but shares you have already sold stay in
          that average, so the figure drifts from your broker once you sell part of a position and
          buy again.
        </p>
      </div>
      <div>
        <p className="font-medium">Advanced lot allocation</p>
        <p className="text-muted-foreground">
          Every purchase is kept as its own lot, and each sale is matched to specific lots: first
          in, first out, unless you change it. Cost basis and unrealized gain then come only from the
          shares you still hold, and the realized gain on each sale follows the lots it used. You can
          change which lots a sale used from the Lot inspector on the Portfolio page.
        </p>
      </div>
      <div className="rounded-lg border p-3">
        <p className="font-medium">Example</p>
        <p className="text-muted-foreground">
          Buy 100 at 10, buy 100 at 20, sell 100, then buy 100 at 30. You hold 200 shares.
        </p>
        <table className="mt-2 w-full text-left">
          <tbody>
            <tr>
              <td className="py-1">Simple</td>
              <td className="py-1 font-mono">4,000</td>
              <td className="py-1 text-muted-foreground">average of all three purchases (20) × 200</td>
            </tr>
            <tr>
              <td className="py-1">Advanced lot allocation</td>
              <td className="py-1 font-mono">5,000</td>
              <td className="py-1 text-muted-foreground">the sale used the first lot; 100 at 20 and 100 at 30 remain</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground">
        Switching never changes a transaction. Your lots are recorded either way, so you can switch
        back at any time and any matching you chose is kept.
      </p>
    </div>
  );
}

/** The choice itself. Rendered on Settings → Investments. */
export function CostBasisSetting() {
  const [status, setStatus] = useCostBasisStatus();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const choose = useCallback(
    async (enabled: boolean) => {
      if (saving || !status || status.enabled === enabled) return;
      setSaving(true);
      setError("");
      setNote("");
      try {
        const res = await fetch("/api/settings/lot-allocation", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) {
          setError(await parseSaveError(res, "Could not change the cost basis method."));
          return;
        }
        const data = (await res.json())?.data as Status & { rebuilt?: number };
        setStatus(data);
        setNote(
          enabled
            ? `Advanced lot allocation is on.${data.rebuilt ? ` Lots were built for ${data.rebuilt} position${data.rebuilt === 1 ? "" : "s"} that had none.` : ""}`
            : "Back to the simple method. Your lots are kept.",
        );
      } catch {
        setError("Could not reach the server. Nothing was changed.");
      } finally {
        setSaving(false);
      }
    },
    [saving, status, setStatus],
  );

  return (
    <Card id="cost-basis">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Cost basis method</CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          How the cost of your holdings, and so their gains, is worked out.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {METHODS.map((m) => {
            const active = status?.enabled === m.enabled;
            return (
              <button
                key={m.name}
                type="button"
                onClick={() => void choose(m.enabled)}
                disabled={saving || !status}
                aria-pressed={active}
                className={`rounded-lg border p-3 text-left transition-colors disabled:opacity-60 ${
                  active ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{m.name}</span>
                  {active && <span className="text-xs text-primary">In use</span>}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{m.summary}</span>
              </button>
            );
          })}
        </div>

        {saving && <p className="text-sm text-muted-foreground">Saving…</p>}
        {note && <p className="text-sm text-emerald-600">{note}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {status?.enabled && status.mismatched > 0 && (
          <p className="rounded-lg border border-amber-500/40 p-3 text-sm">
            {status.mismatched} position{status.mismatched === 1 ? " has" : "s have"} lots that do not add up to the
            shares you hold, so {status.mismatched === 1 ? "its" : "their"} cost basis may be off. Open{" "}
            {status.mismatched === 1 ? "it" : "them"} in the Lot inspector on the{" "}
            <Link href="/portfolio" className="text-primary underline-offset-4 hover:underline">Portfolio page</Link>{" "}
            and choose Rebuild lots.
          </p>
        )}

        <CostBasisExplainer />
      </CardContent>
    </Card>
  );
}

/** One line on the Portfolio page: the method in use, the explanation, and where to change it. */
export function CostBasisNote() {
  const [status] = useCostBasisStatus();
  const [open, setOpen] = useState(false);
  if (!status) return null;
  return (
    <>
      <p className="text-xs text-muted-foreground mt-0.5">
        Cost basis: {status.enabled ? "advanced lot allocation" : "simple average"} ·{" "}
        <button type="button" onClick={() => setOpen(true)} className="text-primary underline-offset-4 hover:underline">
          How it works
        </button>
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>How cost basis is worked out</DialogTitle>
          </DialogHeader>
          <CostBasisExplainer />
          <div className="flex justify-end">
            <Button size="sm" render={<Link href={COST_BASIS_SETTINGS_HREF} />}>
              Change in Settings
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
