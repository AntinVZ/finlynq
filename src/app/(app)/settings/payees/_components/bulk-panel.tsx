"use client";

/**
 * "Наповнення" (P6.2, item 82 / B28): fill the payee directory from every
 * unrecognized counterparty at once. review → propose → ONE confirmation:
 * the table lists clusters at or above the threshold (default 0.9) without
 * "needs decision" and single unrecognized names, each with a name, a
 * merchant-type HINT (applied only when the person clicks it or picks a
 * type), its spellings and row count. Unticked rows stay out. One preview,
 * one batch (30-day undo); stored payees are renamed later by a separate
 * Apply with its own preview. People / ФОП are never here ("Особи" tab).
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OpDialog, type OpPreview } from "./op-dialog";
import { MerchantTypeSelect, type MerchantTypeOption, type MerchantTypeRef } from "./merchant-type-ui";
import { useStudioT } from "./i18n";

export type BulkRowView = {
  rowId: string;
  keys: string[];
  name: string;
  merchantTypeHint: (MerchantTypeRef & { reason: string }) | null;
  spellings: Array<{ spelling: string; count: number }>;
  rows: number;
  transactions: number;
  confidence: number;
  source: "cluster" | "group";
  personReason?: string;
};

export type BulkResponse = {
  threshold: number;
  rows: BulkRowView[];
  people: BulkRowView[];
  left: { belowThreshold: number; needsDecision: number };
  max: number;
};

type Edit = { name?: string; type?: MerchantTypeRef | null };

const THRESHOLDS = [0.99, 0.95, 0.9, 0.85, 0.8, 0.7];

export function useBulkCandidates(threshold: number) {
  return useSWR<BulkResponse>(`/api/payees/bulk?threshold=${threshold}`, jsonFetcher, { revalidateOnFocus: false });
}

export function BulkPanel({ types, onDone }: { types: readonly MerchantTypeOption[]; onDone: () => void }) {
  const t = useStudioT();
  const [threshold, setThreshold] = useState(0.9);
  const { data, mutate } = useBulkCandidates(threshold);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const max = data?.max ?? 300;
  /** The person's ticks; untouched rows: ticked up to the size limit. */
  const [ticks, setTicks] = useState<Map<string, boolean>>(new Map());
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState<number[] | null>(null);
  const [summary, setSummary] = useState<{ created: number; pendingRows: number; ids: number[] } | null>(null);

  const isOn = (rowId: string, index: number) => ticks.get(rowId) ?? index < max;
  const setAll = (on: (index: number) => boolean) => setTicks(new Map(rows.map((r, i) => [r.rowId, on(i)])));
  const chosen = rows.filter((r, i) => isOn(r.rowId, i));
  const tooMany = chosen.length > max;
  const edit = (rowId: string, patch: Edit) => setEdits((e) => ({ ...e, [rowId]: { ...e[rowId], ...patch } }));
  const toggle = (rowId: string, index: number) => setTicks((m) => new Map(m).set(rowId, !isOn(rowId, index)));
  const body = chosen.length
    ? {
        items: chosen.map((r) => {
          const e = edits[r.rowId] ?? {};
          const name = e.name?.trim();
          return { rowId: r.rowId, ...(name && name !== r.name ? { name } : {}), ...(e.type ? { merchantType: e.type } : {}) };
        }),
      }
    : null;

  const finish = (r: OpPreview) => {
    setConfirming(false);
    setEdits({});
    setTicks(new Map());
    setSummary({ created: r.bulk?.created ?? 0, pendingRows: r.bulk?.pendingRows ?? 0, ids: r.bulk?.createdIds ?? [] });
    mutate();
    onDone();
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("bulk.intro")}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5">
          {t("bulk.threshold")}
          <select aria-label={t("bulk.threshold")} className="h-8 rounded-md border bg-background px-2 text-xs" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
            {THRESHOLDS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAll(() => true)}>
          {t("bulk.selectAll")}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAll(() => false)}>
          {t("bulk.selectNone")}
        </Button>
        {rows.length > max && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAll((i) => i < max)}>
            {t("bulk.selectFirst", { n: max })}
          </Button>
        )}
        <span className="text-muted-foreground">{t("bulk.selected", { n: chosen.length, total: rows.length })}</span>
        {data && <span className="text-muted-foreground">{t("bulk.left", { below: data.left.belowThreshold, decision: data.left.needsDecision })}</span>}
        <Button size="sm" className="ml-auto" disabled={!chosen.length || tooMany} onClick={() => setConfirming(true)}>
          {t("bulk.create")}
        </Button>
      </div>
      {tooMany && <p className="text-xs text-destructive">{t("bulk.tooMany", { n: chosen.length, max })}</p>}
      {summary && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-300 p-2 text-sm dark:border-emerald-800">
          <span>{t("bulk.done", { n: summary.created, rows: summary.pendingRows })}</span>
          {summary.pendingRows > 0 && summary.ids.length > 0 && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setApplying(summary.ids)}>
              {t("bulk.apply")}
            </Button>
          )}
        </div>
      )}

      {!data ? (
        <p className="text-sm text-muted-foreground">{t("bulk.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("bulk.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="w-8 p-2" />
                <th className="p-2 text-left">{t("bulk.colName")}</th>
                <th className="p-2 text-left">{t("bulk.colType")}</th>
                <th className="p-2 text-left">{t("bulk.colSpellings")}</th>
                <th className="p-2 text-right">{t("bulk.colRows")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const e = edits[r.rowId] ?? {};
                const on = isOn(r.rowId, i);
                return (
                  <tr key={r.rowId} className={`border-t align-top ${on ? "" : "opacity-50"}`}>
                    <td className="p-2">
                      <input type="checkbox" aria-label={t("bulk.pick", { name: r.name })} checked={on} onChange={() => toggle(r.rowId, i)} />
                    </td>
                    <td className="p-2 min-w-48">
                      <Input className="h-8" aria-label={t("bulk.nameOf", { name: r.name })} value={e.name ?? r.name} onChange={(ev) => edit(r.rowId, { name: ev.target.value })} />
                    </td>
                    <td className="p-2 min-w-48 space-y-1">
                      <MerchantTypeSelect
                        types={types}
                        value={e.type ?? null}
                        onChange={(v) => edit(r.rowId, { type: v })}
                        label={t("bulk.typeOf", { name: r.name })}
                        className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                      />
                      {r.merchantTypeHint && !e.type && (
                        <button
                          type="button"
                          className="text-xs text-sky-700 hover:underline dark:text-sky-300"
                          title={t("bulk.hintTitle", { reason: r.merchantTypeHint.reason })}
                          onClick={() => edit(r.rowId, { type: { group: r.merchantTypeHint!.group, name: r.merchantTypeHint!.name } })}
                        >
                          {t("bulk.useHint", { type: `${r.merchantTypeHint.group} → ${r.merchantTypeHint.name}` })}
                        </button>
                      )}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground break-all">{r.spellings.map((s) => `“${s.spelling}” × ${s.count}`).join(", ")}</td>
                    <td className="p-2 text-right tabular-nums">{r.rows}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirming && (
        <OpDialog
          title={t("bulk.confirmTitle", { n: chosen.length })}
          body={body}
          endpoint="/api/payees/bulk"
          onClose={() => setConfirming(false)}
          onDone={finish}
          confirmLabel={t("bulk.confirm")}
        />
      )}
      {applying && (
        <OpDialog
          title={t("bulk.applyTitle")}
          body={{ op: "apply", entityIds: applying }}
          onClose={() => setApplying(null)}
          onDone={() => {
            setApplying(null);
            setSummary(null);
            onDone();
          }}
        />
      )}
    </div>
  );
}

/** "Особи" (P6.2, B28): people and ФОП never go into a set — each one is decided by hand. */
export function PeoplePanel({ onAdd }: { onAdd: (row: BulkRowView) => void }) {
  const t = useStudioT();
  const { data } = useBulkCandidates(0.9);
  const people = data?.people ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("people.intro")}</p>
      {!data ? (
        <p className="text-sm text-muted-foreground">{t("bulk.loading")}</p>
      ) : people.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("people.empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {people.map((p) => (
            <li key={p.rowId} className="flex flex-wrap items-baseline gap-2 p-3 text-sm">
              <span className="font-medium break-all">{p.name}</span>
              {p.personReason && <span className="text-xs text-amber-700 dark:text-amber-300">{p.personReason}</span>}
              <span className="text-xs text-muted-foreground break-all">{p.spellings.map((s) => `“${s.spelling}” × ${s.count}`).join(", ")}</span>
              <span className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">{t("common.rows", { n: p.rows })}</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onAdd(p)}>
                  {t("people.add")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
