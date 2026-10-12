"use client";

/**
 * "Table" tab of a loan's schedule panel (2026-10-12): the schedule, and the
 * two ways to make it the user's own.
 *
 *   - Calculated schedule: every row's interest can be edited on its own (what
 *     the lender actually charged that payment). The payment stays, so the
 *     principal and later balances follow.
 *   - Manual schedule: the user's own rows replace the calculation. They can
 *     be typed in here, or edited in a spreadsheet: "Download template" gives
 *     a CSV of the current schedule and "Upload schedule" reads it back. There
 *     is no column mapping; the template's first line is the format.
 *
 * All saves go to PUT /api/loans/schedule, which validates by building the
 * resulting schedule. The parent re-fetches the schedule after every change.
 */

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { exportCsv } from "@/lib/csv-export";
import { parseSaveError } from "@/lib/save-error";
import {
  parseScheduleCsv,
  scheduleTemplateRows,
  SCHEDULE_CSV_COLUMNS,
} from "@/lib/loans/manual-schedule";

type Row = {
  period: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
  interestOverridden?: boolean;
};
type DraftRow = { date: string; payment: string; interest: string };
type Pending =
  | { kind: "upload"; rows: { date: string; payment: number; interest: number }[]; file: string }
  | { kind: "to-manual" }
  | { kind: "to-calculated" }
  | { kind: "reset-interest" };

export function LoanScheduleEditor({
  loan,
  schedule,
  mode,
  onChanged,
}: {
  loan: { id: number; name: string; currency: string };
  schedule: Row[];
  mode: "calculated" | "manual";
  /** Called after any saved change, so the page rebuilds the schedule. */
  onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  // Calculated mode: the row whose interest is being edited, and its text.
  const [editDate, setEditDate] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // Manual mode: local copy of the rows while they are being edited.
  const [draft, setDraft] = useState<DraftRow[] | null>(null);

  const overridden = schedule.filter((r) => r.interestOverridden).length;
  const fmt = (n: number) => formatCurrency(n, loan.currency);

  /** PUT a change; returns true when it was saved. Keeps the user's input on failure. */
  async function save(change: Record<string, unknown>): Promise<boolean> {
    if (saving) return false;
    setSaving(true);
    setError("");
    setProblems([]);
    try {
      const res = await fetch("/api/loans/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loanId: loan.id, ...change }),
      });
      if (!res.ok) {
        setError(await parseSaveError(res, "Could not save the schedule."));
        return false;
      }
      onChanged();
      return true;
    } catch {
      setError("Could not reach the server. Nothing was saved.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function downloadTemplate() {
    const safe = loan.name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "loan";
    exportCsv(
      scheduleTemplateRows(schedule),
      SCHEDULE_CSV_COLUMNS.map((c) => ({ header: c, accessor: (r) => r[c] })),
      `${safe}-schedule.csv`,
      // No BOM: the first cell must read exactly "date" when it comes back.
      { bom: false },
    );
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be picked again after a fix
    if (!file) return;
    setError("");
    const parsed = parseScheduleCsv(await file.text());
    if (!parsed.ok) {
      setProblems(parsed.errors);
      return;
    }
    setProblems([]);
    setPending({ kind: "upload", rows: parsed.rows, file: file.name });
  }

  async function confirmPending() {
    if (!pending) return;
    const ok =
      pending.kind === "upload"
        ? await save({ manualSchedule: pending.rows })
        : pending.kind === "to-manual"
          ? await save({
              manualSchedule: schedule.map((r) => ({ date: r.date, payment: r.payment, interest: r.interest })),
            })
          : pending.kind === "to-calculated"
            ? await save({ manualSchedule: null })
            : await save({ clearInterestOverrides: true });
    setPending(null);
    if (ok) setDraft(null);
  }

  async function saveInterest(date: string, raw: string | null) {
    const amount = raw == null ? null : parseFloat(raw);
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
      setError("Interest must be a number, 0 or more.");
      return;
    }
    if (await save({ interestOverrides: { [date]: amount } })) setEditDate(null);
  }

  async function saveDraft() {
    if (!draft) return;
    const rows = draft.map((r) => ({
      date: r.date,
      payment: parseFloat(r.payment),
      interest: parseFloat(r.interest),
    }));
    if (rows.some((r) => !r.date || !Number.isFinite(r.payment) || !Number.isFinite(r.interest))) {
      setError("Every row needs a date, a payment and an interest amount.");
      return;
    }
    if (await save({ manualSchedule: rows })) setDraft(null);
  }

  const setDraftCell = (i: number, key: keyof DraftRow, value: string) =>
    setDraft((cur) => (cur ? cur.map((r, j) => (j === i ? { ...r, [key]: value } : r)) : cur));

  const confirmCopy: Record<Pending["kind"], { title: string; body: string; label: string }> = {
    upload: {
      title: "Replace this loan's schedule?",
      body:
        pending?.kind === "upload"
          ? `${pending.rows.length} payments from ${pending.file} (${pending.rows[0].date} to ${pending.rows[pending.rows.length - 1].date}) will replace every row of the current schedule. Transactions are not changed.`
          : "",
      label: "Replace schedule",
    },
    "to-manual": {
      title: "Switch to a manual schedule?",
      body: "The current rows are kept as your starting point and stop being recalculated. Changing the loan's rate or term will no longer change them. You can go back to the calculated schedule at any time.",
      label: "Switch to manual",
    },
    "to-calculated": {
      title: "Go back to the calculated schedule?",
      body: "Your own rows are discarded and the schedule is worked out again from the loan's amount, rate and term or payment. Transactions are not changed.",
      label: "Use calculated",
    },
    "reset-interest": {
      title: "Reset the edited interest?",
      body: `${overridden} edited payment${overridden === 1 ? "" : "s"} will go back to the calculated interest.`,
      label: "Reset",
    },
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={mode === "manual" ? "default" : "secondary"}>
          {mode === "manual" ? "Manual schedule" : "Calculated schedule"}
        </Badge>
        {mode === "calculated" && overridden > 0 && (
          <span className="text-xs text-muted-foreground">
            {overridden} payment{overridden === 1 ? "" : "s"} with edited interest
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={downloadTemplate} disabled={schedule.length === 0}>
            Download template
          </Button>
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={saving}>
            Upload schedule
          </Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} aria-label="Upload a schedule CSV" />
          {mode === "calculated" ? (
            <>
              {overridden > 0 && (
                <Button size="sm" variant="outline" onClick={() => setPending({ kind: "reset-interest" })} disabled={saving}>
                  Reset edited interest
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setPending({ kind: "to-manual" })} disabled={saving}>
                Switch to manual
              </Button>
            </>
          ) : draft ? (
            <>
              <Button size="sm" variant="outline" onClick={() => { setDraft(null); setError(""); }} disabled={saving}>
                Discard changes
              </Button>
              <Button size="sm" onClick={() => void saveDraft()} disabled={saving}>
                {saving ? "Saving…" : "Save schedule"}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft(schedule.map((r) => ({ date: r.date, payment: String(r.payment), interest: String(r.interest) })))
                }
                disabled={saving}
              >
                Edit rows
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPending({ kind: "to-calculated" })} disabled={saving}>
                Back to calculated
              </Button>
            </>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {mode === "manual"
          ? "These are your own rows. Principal and balance are worked out from each payment and its interest."
          : "Worked out from the loan's amount, rate and term or payment. Edit a payment's interest when your lender charged something different, or switch to manual to set every row yourself."}{" "}
        To work in a spreadsheet, download the template, change it, and upload it back as CSV. Keep its first line; only date, payment and interest are read.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {problems.length > 0 && (
        <div className="rounded-lg border border-destructive/40 p-3 text-sm">
          <p className="font-medium text-destructive">The file was not uploaded. Fix these and try again:</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      <div className="max-h-96 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Payment</TableHead>
              {!draft && <TableHead>Principal</TableHead>}
              <TableHead>Interest</TableHead>
              {!draft && <TableHead>Balance</TableHead>}
              {draft && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft
              ? draft.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell>
                      <Input type="date" className="h-8 w-40" aria-label={`Row ${i + 1} date`} value={r.date} onChange={(e) => setDraftCell(i, "date", e.target.value)} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" step="0.01" min="0" className="h-8 w-28" aria-label={`Row ${i + 1} payment`} value={r.payment} onChange={(e) => setDraftCell(i, "payment", e.target.value)} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" step="0.01" min="0" className="h-8 w-28" aria-label={`Row ${i + 1} interest`} value={r.interest} onChange={(e) => setDraftCell(i, "interest", e.target.value)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setDraft((cur) => (cur ? cur.filter((_, j) => j !== i) : cur))} aria-label={`Remove row ${i + 1}`}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              : schedule.map((r) => (
                  <TableRow key={r.period}>
                    <TableCell>{r.period}</TableCell>
                    <TableCell>{r.date}</TableCell>
                    <TableCell>{fmt(r.payment)}</TableCell>
                    <TableCell className="text-emerald-600">{fmt(r.principal)}</TableCell>
                    <TableCell className="text-rose-600">
                      {mode === "calculated" && editDate === r.date ? (
                        <span className="flex items-center gap-1">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            autoFocus
                            className="h-8 w-28"
                            aria-label={`Interest for ${r.date}`}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void saveInterest(r.date, editValue);
                              if (e.key === "Escape") setEditDate(null);
                            }}
                          />
                          <Button size="sm" onClick={() => void saveInterest(r.date, editValue)} disabled={saving}>Save</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditDate(null)} disabled={saving}>Cancel</Button>
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          {fmt(r.interest)}
                          {r.interestOverridden && <Badge variant="outline" className="text-[10px]">edited</Badge>}
                          {mode === "calculated" && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs text-muted-foreground"
                                onClick={() => { setEditDate(r.date); setEditValue(String(r.interest)); setError(""); }}
                                aria-label={`Edit interest for ${r.date}`}
                              >
                                Edit
                              </Button>
                              {r.interestOverridden && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-xs text-muted-foreground"
                                  onClick={() => void saveInterest(r.date, null)}
                                  disabled={saving}
                                  aria-label={`Reset interest for ${r.date}`}
                                >
                                  Reset
                                </Button>
                              )}
                            </>
                          )}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono">{fmt(r.balance)}</TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      {draft && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDraft((cur) => (cur ? [...cur, { date: "", payment: cur[cur.length - 1]?.payment ?? "", interest: "" }] : cur))}
        >
          Add a row
        </Button>
      )}

      <ConfirmDialog
        open={pending != null}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        title={pending ? confirmCopy[pending.kind].title : ""}
        description={pending ? confirmCopy[pending.kind].body : ""}
        confirmLabel={pending ? confirmCopy[pending.kind].label : "Confirm"}
        busy={saving}
        busyLabel="Saving…"
        onConfirm={() => void confirmPending()}
      />
    </div>
  );
}
