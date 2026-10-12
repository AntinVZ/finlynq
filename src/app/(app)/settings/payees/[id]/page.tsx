"use client";

/**
 * /settings/payees/[id] — one payee in the directory.
 *
 * Name, type, note and a default-category hint; aliases (the spellings and
 * patterns that resolve to it — add, remove, split off into a new payee, or
 * import from a rule's payee condition); requisites in advanced mode; the
 * stored spellings that resolve here; what "Apply" would still rename; and
 * the change history with Undo. Every change is previewed (rows per table)
 * before it is saved, and becomes a batch undoable for 30 days.
 */

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { batchLabel, PAYEE_TYPE_OPTIONS, PayeeAvatar, typeLabel, WebsiteLink, type BatchRow, type PayeeGroupRow, type PayeeSettings } from "../_components/payee-ui";

const LOGO_MAX_BYTES = 20 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
import { OpDialog, describeRows, type OpPreview } from "../_components/op-dialog";
import { RequisitesCard, type Requisite } from "../_components/requisites-card";
import { MerchantTypeSelect, merchantTypeLabel, PayeeTypeLabel, type MerchantTypeOption, type MerchantTypeRef } from "../_components/merchant-type-ui";

type Alias = { id: number; pattern: string; mode: string; source: string };
type Identifier = Requisite;
type EntityResponse = {
  entity: { id: number; name: string; type: string; note: string | null; defaultCategoryId: number | null; website: string | null; logo: string | null; merchantTypeId?: number | null; aliases: Alias[]; identifiers: Identifier[] };
  merchantTypes?: MerchantTypeOption[];
  merchantTypeHint?: { group: string; name: string; reason: string } | null;
  spellings: PayeeGroupRow[];
  pending: { total: number; byTable: Record<string, number>; changes: Array<{ from: string; to: string; count: number }> };
  history: BatchRow[];
  categories: Array<{ id: number; name: string }>;
  currency: string;
};
type Rule = { id: number; name: string; conditions: { all?: Array<{ field?: string; op?: string; value?: string }> } };

const IDENTIFIER_LABEL: Record<string, string> = {
  iban: "IBAN",
  tax_id: "Tax id (ІПН)",
  edrpou: "EDRPOU",
  card_last4: "Card (last 4)",
  crypto_wallet: "Crypto wallet",
};
const SOURCE_LABEL: Record<string, string> = {
  canonical: "canonical name",
  rename: "former name",
  merge: "merged",
  split: "split",
  rule: "from a rule",
  proposal: "AI proposal",
  manual: "added by hand",
};

type Action = { title: string; body: Record<string, unknown> | null; confirm?: string; then?: "back" };

export default function PayeeEntityPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = Number(params?.id);
  const { data, error, mutate } = useSWR<EntityResponse>(Number.isInteger(id) ? `/api/payees/${id}` : null, jsonFetcher, { revalidateOnFocus: false });
  const { data: settings } = useSWR<PayeeSettings>("/api/payees/settings", jsonFetcher, { revalidateOnFocus: false });
  const [action, setAction] = useState<Action | null>(null);
  const [status, setStatus] = useState("");
  const [edit, setEdit] = useState<{ name: string; type: string; merchantType: MerchantTypeRef | null; note: string; categoryId: string } | null>(null);
  const [newAlias, setNewAlias] = useState({ pattern: "", mode: "exact" });
  const [splitIds, setSplitIds] = useState<Set<number>>(new Set());
  const [splitName, setSplitName] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [website, setWebsite] = useState<string | null>(null);
  const [logoError, setLogoError] = useState("");
  const { data: rules } = useSWR<Rule[]>(rulesOpen ? "/api/rules" : null, jsonFetcher, { revalidateOnFocus: false });
  const payeeRules = useMemo(() => (rules ?? []).filter((r) => r.conditions?.all?.some((c) => c.field === "payee" && c.value)), [rules]);

  const e = data?.entity;
  const currency = data?.currency ?? "USD";
  const advanced = settings?.advancedMode ?? false;
  const kinds = settings?.identifierKinds ?? Object.keys(IDENTIFIER_LABEL);

  async function done(r: OpPreview, then?: "back") {
    setAction(null);
    setEdit(null);
    setSplitIds(new Set());
    setNewAlias({ pattern: "", mode: "exact" });
    if (then === "back") {
      router.push("/settings/payees");
      return;
    }
    setStatus(r.undo ? `Undone: restored ${r.undo.restoredRows} row(s).` : `Saved. ${describeRows(r)}`);
    await mutate();
  }

  if (error) return <p className="text-sm text-destructive">Couldn&apos;t load this payee.</p>;
  if (!data || !e) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const types = data.merchantTypes ?? [];
  const currentType = e.merchantTypeId == null ? null : (types.find((t) => t.id === e.merchantTypeId) ?? null);
  const sameType = (a: MerchantTypeRef | null, b: MerchantTypeRef | null) => (a?.group ?? null) === (b?.group ?? null) && (a?.name ?? null) === (b?.name ?? null);
  const editBody = edit
    ? {
        op: "update",
        entityId: e.id,
        ...(edit.name.trim() && edit.name.trim() !== e.name ? { name: edit.name.trim() } : {}),
        ...(edit.type !== e.type ? { type: edit.type } : {}),
        ...(!sameType(edit.merchantType, currentType) ? { merchantType: edit.merchantType ? { group: edit.merchantType.group, name: edit.merchantType.name } : null } : {}),
        ...((edit.note.trim() || null) !== (e.note ?? null) ? { note: edit.note.trim() || null } : {}),
        ...((edit.categoryId ? Number(edit.categoryId) : null) !== e.defaultCategoryId ? { defaultCategoryId: edit.categoryId ? Number(edit.categoryId) : null } : {}),
      }
    : null;
  const editChanged = !!editBody && Object.keys(editBody).length > 2;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link href="/settings/payees" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="h-3 w-3" /> Payees
        </Link>
        <div className="flex flex-wrap items-center gap-2 mt-1">
          <PayeeAvatar id={e.id} name={e.name} hasLogo={e.logo != null} size={36} />
          <h1 className="text-2xl font-bold tracking-tight break-all">{e.name}</h1>
          <Badge variant="outline">
            <PayeeTypeLabel merchantType={currentType} type={e.type} />
          </Badge>
        </div>
        {e.note && <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{e.note}</p>}
        {(() => {
          const current = currentType;
          const hint = current ? null : (data.merchantTypeHint ?? null);
          const setType = (v: { group: string; name: string } | null) =>
            setAction({
              title: v ? `Тип мерчанта: ${merchantTypeLabel(v)}` : "Прибрати тип мерчанта",
              body: { op: "update", entityId: e.id, merchantType: v, apply: false },
              confirm: "Зберегти",
            });
          return (
            <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
              <span className="text-muted-foreground">Тип мерчанта:</span>
              <MerchantTypeSelect types={types} value={current} onChange={setType} />
              {hint && (
                <Button size="sm" variant="outline" className="h-8 text-xs" title={`Підказка: ${hint.reason}. Призначається лише після підтвердження.`} onClick={() => setType(hint)}>
                  Підказка: {merchantTypeLabel(hint)}
                </Button>
              )}
            </div>
          );
        })()}
        <div className="flex flex-wrap gap-2 mt-3">
          <Button size="sm" variant="outline" onClick={() =>
              setEdit({
                name: e.name,
                type: e.type,
                merchantType: currentType ? { group: currentType.group, name: currentType.name } : null,
                note: e.note ?? "",
                categoryId: e.defaultCategoryId ? String(e.defaultCategoryId) : "",
              })
            }>
            Edit
          </Button>
          <Link href={buildTxDrillUrl({ search: e.name })}>
            <Button size="sm" variant="outline">Transactions</Button>
          </Link>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => setAction({ title: `Remove “${e.name}” from the directory`, body: { op: "delete", entityId: e.id }, confirm: "Remove", then: "back" })}
          >
            Remove
          </Button>
        </div>
        {status && <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-2">{status}</p>}
      </div>

      {edit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Edit payee</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input aria-label="Canonical name" value={edit.name} onChange={(ev) => setEdit({ ...edit, name: ev.target.value })} />
            <MerchantTypeSelect types={types} value={edit.merchantType} onChange={(v) => setEdit({ ...edit, merchantType: v })} className="h-9 w-full rounded-md border bg-background px-2 text-sm" />
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Додатково · тип запису: {typeLabel(edit.type)}</summary>
              <label className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Тип запису</span>
                <select aria-label="Type" className="h-8 rounded-md border bg-background px-2 text-sm" value={edit.type} onChange={(ev) => setEdit({ ...edit, type: ev.target.value })}>
                  {PAYEE_TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>{typeLabel(t)}</option>
                  ))}
                </select>
              </label>
              <p className="mt-1 text-muted-foreground">Якщо не змінювати, «Особи і ФОП» сам зробить запис особою.</p>
            </details>
            <textarea
              aria-label="Note"
              className="w-full min-h-16 rounded-md border bg-background p-2 text-sm"
              placeholder="Note (private)"
              value={edit.note}
              onChange={(ev) => setEdit({ ...edit, note: ev.target.value })}
            />
            <label className="block text-xs text-muted-foreground">
              Default category (a hint for suggestions; never applied by itself)
              <select className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={edit.categoryId} onChange={(ev) => setEdit({ ...edit, categoryId: ev.target.value })}>
                <option value="">None</option>
                {data.categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEdit(null)}>Cancel</Button>
              <Button size="sm" disabled={!editChanged} onClick={() => setAction({ title: "Save changes", body: editBody, confirm: "Save" })}>
                Review changes
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Renaming keeps the old name as an alias and renames the stored payees.</p>
          </CardContent>
        </Card>
      )}

      {data.pending.total > 0 && (
        <Card>
          <CardContent className="pt-6 flex flex-wrap items-center gap-2 text-sm">
            <span>
              {data.pending.total} stored row(s) still use another spelling ({data.pending.changes.slice(0, 3).map((c) => `“${c.from}”`).join(", ")}
              {data.pending.changes.length > 3 ? ", …" : ""}).
            </span>
            <Button size="sm" className="ml-auto" onClick={() => setAction({ title: `Rename to “${e.name}”`, body: { op: "apply", entityIds: [e.id] }, confirm: "Rename" })}>
              Apply now
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Website and logo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">Website</span>
            {website === null ? (
              <>
                {e.website ? <WebsiteLink url={e.website} /> : <span className="text-xs text-muted-foreground">None</span>}
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setWebsite(e.website ?? "")}>
                  {e.website ? "Change" : "Add"}
                </Button>
                {e.website && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => setAction({ title: "Remove the website", body: { op: "update", entityId: e.id, website: null, apply: false }, confirm: "Remove" })}>
                    Remove
                  </Button>
                )}
              </>
            ) : (
              <>
                <Input className="max-w-sm" aria-label="Website" placeholder="example.com" value={website} onChange={(ev) => setWebsite(ev.target.value)} />
                <Button
                  size="sm"
                  disabled={!website.trim()}
                  onClick={() => {
                    setAction({ title: "Save the website", body: { op: "update", entityId: e.id, website: website.trim(), apply: false }, confirm: "Save" });
                    setWebsite(null);
                  }}
                >
                  Save…
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setWebsite(null)}>Cancel</Button>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">Logo</span>
            {e.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={e.logo} alt={`${e.name} logo`} className="h-10 w-10 rounded border object-contain bg-white" />
            ) : (
              <span className="text-xs text-muted-foreground">None</span>
            )}
            <label className="inline-flex cursor-pointer items-center rounded-md border px-2 py-1 text-xs hover:bg-accent">
              {e.logo ? "Replace…" : "Upload…"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                aria-label="Logo file"
                onChange={(ev) => {
                  const file = ev.target.files?.[0];
                  ev.target.value = "";
                  setLogoError("");
                  if (!file) return;
                  if (!LOGO_TYPES.includes(file.type)) return setLogoError("Use a PNG, JPEG or WebP image (SVG is not allowed).");
                  if (file.size > LOGO_MAX_BYTES) return setLogoError(`The image is ${Math.ceil(file.size / 1024)} KB; the limit is 20 KB.`);
                  const reader = new FileReader();
                  reader.onload = () => setAction({ title: "Save the logo", body: { op: "update", entityId: e.id, logo: String(reader.result), apply: false }, confirm: "Save" });
                  reader.readAsDataURL(file);
                }}
              />
            </label>
            {e.logo && (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => setAction({ title: "Remove the logo", body: { op: "update", entityId: e.id, logo: null, apply: false }, confirm: "Remove" })}>
                Remove
              </Button>
            )}
          </div>
          {logoError && <p className="text-xs text-destructive">{logoError}</p>}
          <p className="text-xs text-muted-foreground">PNG, JPEG or WebP up to 20 KB. Finlynq never looks sites or logos up online; your AI assistant can propose them.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Aliases</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Exact aliases ignore letter case, apostrophes, Latin/Cyrillic spelling and card-terminal noise. “Contains” and “regex” cover families of spellings.
          </p>
          <ul className="divide-y rounded-lg border">
            {e.aliases.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                {a.source !== "canonical" && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${a.pattern} for split`}
                    checked={splitIds.has(a.id)}
                    onChange={() => setSplitIds((prev) => { const n = new Set(prev); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })}
                  />
                )}
                <span className="break-all">{a.pattern}</span>
                {a.mode !== "exact" && <Badge variant="secondary">{a.mode}</Badge>}
                <span className="text-xs text-muted-foreground">{SOURCE_LABEL[a.source] ?? a.source}</span>
                {a.source !== "canonical" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 text-xs text-destructive"
                    onClick={() => setAction({ title: `Remove alias “${a.pattern}”`, body: { op: "alias_remove", entityId: e.id, aliasIds: [a.id] }, confirm: "Remove" })}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {splitIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <span className="text-sm">Split {splitIds.size} alias(es) into a new payee:</span>
              <Input className="max-w-xs" aria-label="New payee name" placeholder="New payee name" value={splitName} onChange={(ev) => setSplitName(ev.target.value)} />
              <Button
                size="sm"
                disabled={!splitName.trim()}
                onClick={() => setAction({ title: `Split into “${splitName.trim()}”`, body: { op: "split", entityId: e.id, aliasIds: [...splitIds], name: splitName.trim() }, confirm: "Split" })}
              >
                Split…
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input className="flex-1 min-w-48" aria-label="New alias" placeholder="Add a spelling or pattern" value={newAlias.pattern} onChange={(ev) => setNewAlias({ ...newAlias, pattern: ev.target.value })} />
            <select aria-label="Alias mode" className="h-9 rounded-md border bg-background px-2 text-sm" value={newAlias.mode} onChange={(ev) => setNewAlias({ ...newAlias, mode: ev.target.value })}>
              <option value="exact">Exact</option>
              <option value="contains">Contains</option>
              <option value="regex">Regex</option>
            </select>
            <Button
              size="sm"
              disabled={!newAlias.pattern.trim()}
              onClick={() => setAction({ title: `Add alias “${newAlias.pattern.trim()}”`, body: { op: "alias_add", entityId: e.id, aliases: [{ pattern: newAlias.pattern.trim(), mode: newAlias.mode }] }, confirm: "Add" })}
            >
              Add…
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRulesOpen((v) => !v)}>
              From a rule
            </Button>
          </div>
          {rulesOpen && (
            <div className="rounded-md border p-2 text-sm space-y-1">
              {!rules ? (
                <p className="text-xs text-muted-foreground">Loading rules…</p>
              ) : payeeRules.length === 0 ? (
                <p className="text-xs text-muted-foreground">No rules match on the payee.</p>
              ) : (
                payeeRules.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <span className="text-xs text-muted-foreground break-all">
                      {r.conditions.all!.filter((c) => c.field === "payee").map((c) => `${c.op} “${c.value}”`).join(", ")}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7 text-xs"
                      onClick={() => setAction({ title: `Aliases from rule “${r.name}”`, body: { op: "alias_from_rule", ruleId: r.id, entityId: e.id }, confirm: "Add" })}
                    >
                      Use
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {advanced && (
        <RequisitesCard
          entityId={e.id}
          entityType={e.type}
          requisites={e.identifiers}
          allowedKinds={kinds}
          onAction={(a) => setAction({ title: a.title, body: a.body, confirm: a.confirm })}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stored spellings</CardTitle>
        </CardHeader>
        <CardContent>
          {data.spellings.length === 0 ? (
            <p className="text-xs text-muted-foreground">No stored payee resolves to this entry yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.spellings.flatMap((g) =>
                g.spellings.map((s) => (
                  <li key={`${g.key}|${s.spelling}`} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                    <span className="break-all">{s.spelling}</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">× {s.count}</span>
                  </li>
                )),
              )}
              <li className="p-2 text-xs text-muted-foreground tabular-nums">
                {data.spellings.reduce((n, g) => n + g.count, 0)} transactions · {formatCurrency(data.spellings.reduce((n, g) => n + g.total, 0), currency)}
              </li>
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent>
          {data.history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No changes yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.history.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                  <span className="font-medium">#{b.id}</span>
                  <span>{batchLabel(b)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{b.createdAt.slice(0, 16).replace("T", " ")}</span>
                  <span className="ml-auto">
                    {b.undoneAt ? (
                      <span className="text-xs text-muted-foreground">Undone</span>
                    ) : b.canUndo ? (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAction({ title: `Undo change #${b.id}`, body: { op: "undo", batchId: b.id }, confirm: "Undo" })}>
                        Undo
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {action && (
        <OpDialog title={action.title} body={action.body} confirmLabel={action.confirm} onClose={() => setAction(null)} onDone={(r) => done(r, action.then)} />
      )}
    </div>
  );
}
