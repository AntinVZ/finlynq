"use client";

/**
 * FilePane — right pane of the /import/pending two-pane UI (FINLYNQ-56).
 * Renders staged rows (file-side, from `staged_transactions`) for the
 * currently-selected account, with the existing per-row inline editor
 * exposed via expansion and the new RowBadge surfacing reconcile_state.
 *
 * Phase 2 scope: read-only (selection + expand + edit only). Phase 3
 * adds the link/unlink/skip action group + suggestions integration.
 *
 * Selection (approve queue) and expansion (editor visibility) are owned
 * by the parent — this component just renders + emits events.
 */

import { Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import {
  StagedRowEditor,
  type StagedEditableRow,
  type AccountOption,
  type HoldingOption,
} from "@/components/staging/staged-row-editor";
import { RowBadge, type ReconcileState } from "./row-badge";
import { RecommendedChip, usePayeeRecommendations } from "@/components/payees/recommended-chip";
import { matchRowClass, type PaneMatchStatus } from "./match-status";

const RowFragment = Fragment;

export interface FilePaneProps {
  stagedImportId: string;
  rows: StagedEditableRow[];
  selected: Set<string>;
  expanded: Set<string>;
  accounts: AccountOption[];
  holdings: HoldingOption[];
  onToggleSelect: (rowId: string) => void;
  onToggleExpand: (rowId: string) => void;
  onRowUpdated: (updated: StagedEditableRow) => void;
  /** Phase 3 — optional right-side action column per row. */
  rowActions?: (row: StagedEditableRow) => React.ReactNode;
  /** Phase 3 — optional pinned content rendered above the table (the
   *  auto-match SuggestionsGroup). Composes cleanly with empty state. */
  header?: React.ReactNode;
  /**
   * 2026-05-24 — bank balance anchors parsed from the uploaded file's
   * Balance column. Map of YYYY-MM-DD → balance value. When non-empty,
   * the pane renders a Balance column showing the file's stated balance
   * on the FIRST row of each day in display order. Empty map = no
   * column rendered.
   */
  anchorsByDate?: Map<string, number>;
  /** Plan #5 Phase 3 — click on a row body (excluding the checkbox /
   *  chevron / action buttons) drives the cross-pane highlight UX. */
  onRowClick?: (stagedId: string) => void;
  /** Staged row ids currently highlighted by a click-through. */
  highlightedStagedIds?: ReadonlySet<string>;
  /** Persistent cross-pane match status per staged id (computePanePairing).
   *  'matched' = a bank row covers it; 'only_file' = new (no bank counterpart).
   *  Absent → no tint. */
  matchStatus?: ReadonlyMap<string, PaneMatchStatus>;
}

export function FilePane({
  stagedImportId,
  rows,
  selected,
  expanded,
  accounts,
  holdings,
  onToggleSelect,
  onToggleExpand,
  onRowUpdated,
  rowActions,
  header,
  anchorsByDate,
  onRowClick,
  highlightedStagedIds,
  matchStatus,
}: FilePaneProps) {
  // P8 stage 4: «Рекомендовано: X» when a row's payee resolves to a
  // directory entry under another name; one click saves that name.
  const recommendationFor = usePayeeRecommendations(rows.map((r) => r.payee));
  async function applyPayee(row: StagedEditableRow, name: string) {
    const res = await fetch(`/api/import/staged/${stagedImportId}/rows/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payee: name }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    if (res?.ok && data?.row) onRowUpdated(data.row as StagedEditableRow);
  }
  if (rows.length === 0) {
    return (
      <>
        {header}
        <p className="p-6 text-sm text-muted-foreground text-center">
          No staged rows for this account.
        </p>
      </>
    );
  }

  // 2026-05-24 — "one balance per day" rule. Track which dates have
  // already had a balance cell rendered (rows are sorted newest-first
  // by the server, so the FIRST row of each day in display order is
  // the most recent transaction of that day).
  const balanceShownForDate = new Set<string>();
  const hasAnyAnchor = (anchorsByDate?.size ?? 0) > 0;
  // Select-all is the "default automatic path" — it should tick only the rows
  // that still need loading. Exclude:
  //   • row_status='approved'  — already pushed to the bank ledger
  //   • reconcileState='linked' — already matched to an existing ledger tx
  //   • reconcileState='skipped_duplicate' — an exact/fuzzy duplicate we already
  //     have (the fuzzy net catches email-loaded charges under a drifted payee)
  // Any of these can still be picked individually via its own row checkbox
  // (linked → Unlink, skipped → Un-skip/force-load) — they're just kept out of
  // the bulk select so the user can't re-load a duplicate by accident.
  const selectableRows = rows.filter(
    (r) =>
      r.rowStatus !== "approved" &&
      r.reconcileState !== "linked" &&
      r.reconcileState !== "skipped_duplicate",
  );
  // colSpan for the expanded editor row must cover every header column.
  // Columns: checkbox (1) + chevron (2) + Date (3) + Payee (4) + Type (5)
  //          + Amount (6) [+ Balance (7)] [+ Actions (last)]
  const editorColSpan = 6 + (hasAnyAnchor ? 1 : 0) + (rowActions ? 1 : 0);

  return (
    <div className="flex flex-col h-full">
      {header}
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  // Already-imported rows (row_status='approved') aren't
                  // selectable — they've been pushed to the bank ledger — so
                  // select-all operates only on the still-sendable rows.
                  checked={
                    selectableRows.length > 0 &&
                    selectableRows.every((r) => selected.has(r.id))
                  }
                  onChange={() => {
                    const everySelected = selectableRows.every((r) => selected.has(r.id));
                    if (everySelected) {
                      selectableRows.forEach((r) => onToggleSelect(r.id));
                    } else {
                      selectableRows
                        .filter((r) => !selected.has(r.id))
                        .forEach((r) => onToggleSelect(r.id));
                    }
                  }}
                  aria-label="Select all sendable rows"
                />
              </TableHead>
              <TableHead className="w-8" />
              <TableHead>Date</TableHead>
              <TableHead>Payee</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              {hasAnyAnchor && (
                <TableHead className="text-right">Balance</TableHead>
              )}
              {rowActions && <TableHead className="w-32 text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const isExpanded = expanded.has(r.id);
              // Pushed to the bank ledger on a prior "Send" — kept visible,
              // highlighted, not re-sendable.
              const isImported = r.rowStatus === "approved";
              const dimmed =
                r.reconcileState === "skipped_duplicate"
                  ? "opacity-60 line-through"
                  : r.isDuplicate || r.reconcileState === "linked"
                    ? "opacity-60"
                    : "";
              const importedClass = isImported
                ? "bg-emerald-500/10 hover:bg-emerald-500/15"
                : "";
              const dayBalance = hasAnyAnchor ? anchorsByDate?.get(r.date) : undefined;
              const showBalance =
                hasAnyAnchor &&
                dayBalance !== undefined &&
                !balanceShownForDate.has(r.date);
              if (showBalance) balanceShownForDate.add(r.date);
              const highlighted = highlightedStagedIds?.has(r.id) ?? false;
              // Ring (not a bg) so the click highlight layers cleanly over the
              // persistent full-row match tint.
              const highlightClass = highlighted
                ? "ring-2 ring-inset ring-sky-500/60"
                : "";
              const ms = matchStatus?.get(r.id);
              const clickable = onRowClick != null;
              return (
                <RowFragment key={r.id}>
                  <TableRow
                    className={`h-11 ${dimmed} ${importedClass} ${matchRowClass(ms)} ${highlightClass} ${clickable ? "cursor-pointer" : ""}`}
                    onClick={
                      clickable
                        ? (e) => {
                            // The row carries an interactive checkbox + the
                            // chevron expand button + optional action buttons
                            // (Link / Skip / Unlink). Suppress the row-click
                            // when the target is inside any of them so those
                            // actions retain their original semantics.
                            const target = e.target as HTMLElement;
                            if (target.closest("button")) return;
                            if (target.closest("input")) return;
                            onRowClick?.(r.id);
                          }
                        : undefined
                    }
                  >
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => onToggleSelect(r.id)}
                        disabled={isImported}
                        title={isImported ? "Already loaded into the bank ledger" : undefined}
                        aria-label={`Select row ${r.rowIndex}`}
                      />
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => onToggleExpand(r.id)}
                        aria-label={isExpanded ? "Collapse row editor" : "Edit row"}
                        className="text-muted-foreground hover:text-foreground p-1 -m-1"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.date}</TableCell>
                    <TableCell className="text-xs truncate max-w-[220px]">
                      {r.payee || (
                        <span className="text-muted-foreground">—</span>
                      )}
                      <RecommendedChip rec={recommendationFor(r.payee)} onApply={(name) => void applyPayee(r, name)} />
                      {r.category && (
                        <span className="text-muted-foreground"> · {r.category}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="flex items-center gap-1 flex-nowrap">
                        {r.txType === "R" ? (
                          <Badge variant="outline" className="text-[10px]">
                            Transfer
                          </Badge>
                        ) : r.txType === "I" ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                          >
                            Income
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Expense
                          </Badge>
                        )}
                        {r.isDuplicate && r.reconcileState !== "skipped_duplicate" && (
                          <Badge variant="outline" className="text-[10px]">
                            dupe
                          </Badge>
                        )}
                        {isImported && (
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200"
                          >
                            imported
                          </Badge>
                        )}
                        <RowBadge
                          state={r.reconcileState as ReconcileState}
                          linkedTransactionId={r.linkedTransactionId ?? null}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatCurrency(r.amount, r.currency || "CAD")}
                    </TableCell>
                    {hasAnyAnchor && (
                      <TableCell
                        className="text-right font-mono text-xs"
                        title={
                          showBalance
                            ? `Bank-stated balance from file on ${r.date}`
                            : undefined
                        }
                      >
                        {showBalance && dayBalance !== undefined
                          ? formatCurrency(dayBalance, r.currency || "CAD")
                          : ""}
                      </TableCell>
                    )}
                    {rowActions && (
                      <TableCell className="text-right">
                        {rowActions(r)}
                      </TableCell>
                    )}
                  </TableRow>
                  {isExpanded && (
                    <TableRow>
                      <TableCell colSpan={editorColSpan} className="p-0">
                        <StagedRowEditor
                          stagedImportId={stagedImportId}
                          row={r}
                          siblingRows={rows}
                          accounts={accounts}
                          holdings={holdings}
                          onUpdated={onRowUpdated}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </RowFragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
