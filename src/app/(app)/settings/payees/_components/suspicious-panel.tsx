"use client";

/**
 * "Перевірити" (P6.2, item 83): directory entries with a short or
 * meaningless name (`Ma`, `Galia baluvana`), each with the reason it is
 * listed, its rows and spellings. Nothing changes by itself; per entry:
 * rename, merge into another entry, delete the entry (its transaction rows
 * stay), or mark it as checked so it is not listed again. Every action is
 * previewed and becomes an undoable batch.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OpDialog, type OpPreview } from "./op-dialog";
import { EntityPicker, type EntityOption } from "./entity-picker";
import { useStudioT } from "./i18n";

export type SuspiciousRow = {
  id: number;
  name: string;
  reasons: Array<{ code: string; reason: string }>;
  count: number;
  spellings: Array<{ spelling: string; count: number }>;
};

type Action = { kind: "rename" | "merge" | "delete" | "reviewed"; row: SuspiciousRow };

export function SuspiciousPanel({ rows, entities, onDone }: { rows: SuspiciousRow[]; entities: EntityOption[]; onDone: (r: OpPreview) => void }) {
  const t = useStudioT();
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState("");
  const [into, setInto] = useState<number | null>(null);

  const open = (kind: Action["kind"], row: SuspiciousRow) => {
    setName(row.name);
    setInto(null);
    setAction({ kind, row });
  };
  const close = () => setAction(null);
  const finish = (r: OpPreview) => {
    setAction(null);
    onDone(r);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("suspicious.intro")}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("suspicious.empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map((r) => (
            <li key={r.id} className="p-3 space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <Link href={`/settings/payees/${r.id}`} className="font-medium hover:underline break-all">
                  {r.name}
                </Link>
                <span className="text-xs text-amber-700 dark:text-amber-300">{r.reasons.map((x) => x.reason).join("; ")}</span>
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">{t("common.rows", { n: r.count })}</span>
              </div>
              {r.spellings.length > 0 && (
                <p className="text-xs text-muted-foreground break-all">
                  {t("suspicious.spellings")}: {r.spellings.map((s) => `“${s.spelling}” × ${s.count}`).join(", ")}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" className="h-7 text-xs" render={<Link href={`/settings/payees/${r.id}`} />}>
                  {t("suspicious.rows")}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => open("rename", r)}>
                  {t("suspicious.rename")}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => open("merge", r)}>
                  {t("suspicious.merge")}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => open("delete", r)}>
                  {t("suspicious.delete")}
                </Button>
                <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => open("reviewed", r)}>
                  {t("suspicious.reviewed")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {action?.kind === "rename" && (
        <OpDialog
          title={t("suspicious.renameTitle", { name: action.row.name })}
          body={name.trim() && name.trim() !== action.row.name ? { op: "update", entityId: action.row.id, name: name.trim() } : null}
          onClose={close}
          onDone={finish}
          confirmLabel={t("suspicious.rename")}
        >
          <Input aria-label={t("suspicious.newName")} value={name} onChange={(e) => setName(e.target.value)} />
        </OpDialog>
      )}
      {action?.kind === "merge" && (
        <OpDialog
          title={t("suspicious.mergeTitle", { name: action.row.name })}
          body={into != null ? { op: "merge", into: { entityId: into }, entityIds: [action.row.id] } : null}
          onClose={close}
          onDone={finish}
          confirmLabel={t("suspicious.merge")}
        >
          <EntityPicker entities={entities.filter((e) => e.id !== action.row.id)} value={into} onChange={setInto} />
        </OpDialog>
      )}
      {action?.kind === "delete" && (
        <OpDialog title={t("suspicious.deleteTitle", { name: action.row.name })} body={{ op: "delete", entityId: action.row.id }} onClose={close} onDone={finish} confirmLabel={t("suspicious.delete")}>
          <p className="text-xs text-muted-foreground">{t("suspicious.deleteNote")}</p>
        </OpDialog>
      )}
      {action?.kind === "reviewed" && (
        <OpDialog
          title={t("suspicious.reviewedTitle", { name: action.row.name })}
          body={{ op: "mark_reviewed", entityIds: [action.row.id] }}
          onClose={close}
          onDone={finish}
          confirmLabel={t("suspicious.reviewed")}
        >
          <p className="text-xs text-muted-foreground">{t("suspicious.reviewedNote")}</p>
        </OpDialog>
      )}
    </div>
  );
}
