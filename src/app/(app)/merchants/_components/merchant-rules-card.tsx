"use client";

/**
 * Rules on a merchant's page (P8 stage 10): the rules that name this entry
 * or its merchant type, with their priority and hit count; «Створити
 * правило» (the shared rule editor, seeded with `merchant is …` and the
 * default category, with «Перевірити на моїх операціях» = test_rule); and
 * «Категорія для N без категорії» — the default category given to this
 * merchant's uncategorized transactions through the usual preview → confirm
 * → undoable batch.
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RuleEditorDialog, type Category } from "@/components/rules/rule-editor-dialog";
import type { Action, Condition } from "@/lib/rules/schema";
import { useT } from "@/lib/i18n/client";

type RuleRow = { id: number; name: string; priority: number; isActive: boolean; hitCount?: number; conditions: { all?: Condition[] }; actions?: Action[] };

export function MerchantRulesCard({
  entity,
  merchantTypeId,
  defaultCategoryId,
  uncategorized,
  onApplyCategory,
}: {
  entity: { id: number; name: string };
  merchantTypeId: number | null;
  /** The entry's default category, else its merchant type's. */
  defaultCategoryId: number | null;
  uncategorized: number | null;
  onApplyCategory: () => void;
}) {
  const t = useT();
  const { data, mutate } = useSWR<unknown>("/api/rules", jsonFetcher, { revalidateOnFocus: false });
  const [creating, setCreating] = useState(false);
  const { data: categories } = useSWR<Category[]>(creating ? "/api/categories" : null, jsonFetcher, { revalidateOnFocus: false });
  const rules = useMemo(
    () =>
      (Array.isArray(data) ? (data as RuleRow[]) : []).filter((r) =>
        (r.conditions?.all ?? []).some((c) => (c.field === "merchant" && c.entityId === entity.id) || (c.field === "merchant_type" && merchantTypeId != null && c.typeId === merchantTypeId)),
      ),
    [data, entity.id, merchantTypeId],
  );
  const catId = defaultCategoryId ?? categories?.[0]?.id ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("merchantRules.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("merchantRules.none")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rules.map((r) => (
              <li key={r.id} className={`flex flex-wrap items-center gap-2 p-2 ${r.isActive ? "" : "opacity-60"}`}>
                <span className="font-medium">{r.name}</span>
                {(r.conditions?.all ?? []).some((c) => c.field === "merchant_type") && <Badge variant="outline" className="text-[10px]">{t("merchantRules.byType")}</Badge>}
                <Badge variant="secondary" className="text-[10px]">{t("rules.priority", { n: r.priority })}</Badge>
                <span className="ms-auto text-xs text-muted-foreground">{t("rules.hits", { n: r.hitCount ?? 0 })}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            {t("merchantRules.create")}
          </Button>
          {defaultCategoryId != null && (uncategorized ?? 1) > 0 && (
            <Button size="sm" variant="outline" onClick={onApplyCategory}>
              {uncategorized != null ? t("merchantRules.applyN", { n: uncategorized }) : t("merchantRules.apply")}
            </Button>
          )}
        </div>
        {defaultCategoryId == null && <p className="text-xs text-muted-foreground">{t("merchantRules.noDefault")}</p>}
      </CardContent>
      {creating && categories && (
        <RuleEditorDialog
          initialName={entity.name}
          initialConditions={[{ field: "merchant", op: "is", entityId: entity.id }]}
          initialActions={catId ? [{ kind: "set_category", categoryId: catId }] : undefined}
          categories={categories}
          accounts={[]}
          holdings={[]}
          onClose={(saved) => {
            setCreating(false);
            if (saved) void mutate();
          }}
          onSubmit={async (payload) => {
            const res = await fetch("/api/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null);
            if (!res || !res.ok) {
              const d = res ? await res.json().catch(() => null) : null;
              return { ok: false, error: d?.error ?? t("merchantRules.saveFailed") };
            }
            const saved = await res.json().catch(() => null);
            return { ok: true, ruleId: typeof saved?.id === "number" ? saved.id : undefined };
          }}
        />
      )}
    </Card>
  );
}
