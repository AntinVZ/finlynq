"use client";

/**
 * "Interest entries" tab of a loan's schedule panel (2026-10-12).
 *
 * A loan payment is a plain transfer into the loan account. The interest is a
 * separate expense entry on that same account, and this panel creates it: one
 * row per payment date that has arrived, with the schedule's interest as the
 * default amount. The amount is editable, so a lender whose figure differs
 * from the calculated one (a fixed charge, a rate change) is still booked
 * correctly. Posted periods link to their transaction; deleting that
 * transaction in the Transactions list makes the period postable again.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { parseSaveError } from "@/lib/save-error";
import { todayISO } from "@/lib/utils/date";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { dueUnpostedInterest, type InterestScheduleRow } from "@/lib/loans/interest-plan";

type Posting = { periodDate: string; transactionId: number; amount: number; date: string };
type Category = { id: number; name: string; type: string };

export function LoanInterestEntries({
  loan,
  schedule,
  onPosted,
}: {
  loan: { id: number; currency: string; accountId: number | null; accountName: string | null };
  schedule: InterestScheduleRow[];
  /** Called after entries are created, so the page can refresh the loan's balance. */
  onPosted?: () => void;
}) {
  const [postings, setPostings] = useState<Posting[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState("");
  // Per-period amount edits, keyed by the schedule row's date.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const loadPostings = useCallback(async () => {
    try {
      const res = await fetch(`/api/loans/interest?loanId=${loan.id}`);
      const json = res.ok ? await res.json() : null;
      setPostings(Array.isArray(json?.data?.postings) ? json.data.postings : []);
    } catch {
      setPostings([]);
    } finally {
      setLoaded(true);
    }
  }, [loan.id]);

  useEffect(() => {
    setLoaded(false);
    setEdits({});
    setError("");
    void loadPostings();
  }, [loadPostings]);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Category[]) => {
        const expense = (Array.isArray(data) ? data : []).filter((c) => c.type === "E");
        setCategories(expense);
        // Pre-select a category that already says "interest", if there is one.
        const match = expense.find((c) => /interest/i.test(c.name ?? ""));
        if (match) setCategoryId((cur) => cur || String(match.id));
      })
      .catch(() => {});
  }, []);

  const today = todayISO();
  const postedByDate = useMemo(
    () => new Map(postings.map((p) => [p.periodDate, p])),
    [postings],
  );
  const due = useMemo(
    () => dueUnpostedInterest(schedule, new Set(postedByDate.keys()), today),
    [schedule, postedByDate, today],
  );
  // Everything that has come due, newest first, plus the next upcoming payment
  // so a user booking slightly ahead of the due date can still do it.
  const rows = useMemo(() => {
    const past = schedule.filter((r) => r.date <= today);
    const next = schedule.find((r) => r.date > today);
    return (next ? [...past, next] : past).slice().reverse();
  }, [schedule, today]);

  const amountFor = (r: InterestScheduleRow): number => {
    const raw = edits[r.date];
    if (raw === undefined) return r.interest;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : NaN;
  };

  async function post(target: InterestScheduleRow[]) {
    if (saving) return;
    if (!categoryId) {
      setError("Pick the category to book the interest under.");
      return;
    }
    const entries = target.map((r) => ({ periodDate: r.date, amount: amountFor(r) }));
    if (entries.some((e) => !Number.isFinite(e.amount) || e.amount < 0.01)) {
      setError("Each interest amount must be at least 0.01.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/loans/interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: loan.id, categoryId: Number(categoryId), entries }),
      });
      if (!res.ok) {
        setError(await parseSaveError(res, "Could not create the interest entry."));
        return;
      }
      setEdits({});
      await loadPostings();
      onPosted?.();
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loan.accountId == null) {
    return (
      <p className="text-sm text-muted-foreground">
        Link this loan to an account (Edit, then Linked account) to book its interest. Interest is
        recorded as an expense on the loan&apos;s own account, so the account is where it has to go.
      </p>
    );
  }

  const dueTotal = due.reduce((s, r) => s + (Number.isFinite(amountFor(r)) ? amountFor(r) : 0), 0);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Record each payment as a plain transfer into{" "}
        <span className="font-medium text-foreground">{loan.accountName ?? "the loan account"}</span>.
        The interest is booked separately here, as an expense on that same account, so the balance
        falls by the principal only and the interest shows in your reports. Change an amount when
        your lender&apos;s figure differs from the calculated one.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Label className="mb-1 block text-xs text-muted-foreground">Book interest under</Label>
          <Combobox
            value={categoryId}
            onValueChange={(v) => { setCategoryId(v); setError(""); }}
            items={categories.map((c): ComboboxItemShape => ({ value: String(c.id), label: c.name }))}
            placeholder="Pick an expense category"
          />
        </div>
        <Button onClick={() => post(due)} disabled={saving || due.length === 0}>
          {due.length === 0
            ? "Nothing due"
            : `Generate ${due.length} due ${due.length === 1 ? "entry" : "entries"} (${formatCurrency(dueTotal, loan.currency)})`}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="max-h-96 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Payment date</TableHead>
              <TableHead>Calculated interest</TableHead>
              <TableHead>Interest to book</TableHead>
              <TableHead className="text-right">Entry</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const posted = postedByDate.get(r.date);
              return (
                <TableRow key={r.date}>
                  <TableCell className="font-mono">
                    {r.date}
                    {r.date > today && <span className="ml-2 text-xs text-muted-foreground">upcoming</span>}
                  </TableCell>
                  <TableCell className="font-mono text-rose-600">{formatCurrency(r.interest, loan.currency)}</TableCell>
                  <TableCell>
                    {posted ? (
                      <span className="font-mono">{formatCurrency(Math.abs(posted.amount), loan.currency)}</span>
                    ) : (
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        aria-label={`Interest to book for ${r.date}`}
                        className="h-8 w-32"
                        value={edits[r.date] ?? String(r.interest)}
                        onChange={(e) => { setEdits((cur) => ({ ...cur, [r.date]: e.target.value })); setError(""); }}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {posted ? (
                      <Link
                        href={buildTxDrillUrl({ id: String(posted.transactionId) })}
                        className="text-sm text-primary underline-offset-4 hover:underline"
                      >
                        Posted, view entry
                      </Link>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => post([r])} disabled={saving || !loaded}>
                        Generate
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                  No payments on this schedule yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
