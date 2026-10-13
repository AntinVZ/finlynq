"use client";

/**
 * /merchants/[id] — one payee in the directory.
 *
 * Name, type, note and a default-category hint; aliases (the spellings and
 * patterns that resolve to it — add, remove, split off into a new payee, or
 * import from a rule's payee condition); requisites in advanced mode; the
 * stored spellings that resolve here; what "Apply" would still rename; and
 * the change history with Undo. Every change is previewed (rows per table)
 * before it is saved, and becomes a batch undoable for 30 days.
 *
 * P8 stage 1: the merchant's page — 12-month numbers (sum, count, average
 * payment, last date, a sparkline), recent transactions, «Написання», the
 * default category, and requisites masked until "Show" is confirmed.
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
import { formatCurrency, formatDate } from "@/lib/i18n/format-current";
import { Sparkline } from "@/components/merchants/sparkline";
import { HelpHint, ListSkeleton, LoadError } from "@/components/merchants/state";
import { useUndoToast } from "@/components/merchants/undo-toast";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { batchLabel, PAYEE_TYPE_OPTIONS, PayeeAvatar, typeLabel, WebsiteLink, type BatchRow, type PayeeGroupRow, type PayeeSettings } from "../_components/payee-ui";

const LOGO_MAX_BYTES = 20 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
import { OpDialog, describeRows, type OpPreview } from "../_components/op-dialog";
import { RequisitesCard, type Requisite } from "../_components/requisites-card";
import { MerchantTypeSelect, merchantTypeLabel, PayeeTypeLabel, type MerchantTypeOption, type MerchantTypeRef } from "../_components/merchant-type-ui";
import { useStudioT } from "../_components/i18n";
import { MerchantRulesCard } from "../_components/merchant-rules-card";
import type { StudioTextKey } from "@/lib/payees/i18n";

type Alias = { id: number; pattern: string; mode: string; source: string };
type Identifier = Requisite;
type EntityResponse = {
  entity: { id: number; name: string; type: string; note: string | null; defaultCategoryId: number | null; website: string | null; logo: string | null; merchantTypeId?: number | null; aliases: Alias[]; identifiers: Identifier[] };
  merchantTypes?: MerchantTypeOption[];
  merchantTypeHint?: { group: string; name: string; reason: string; strength?: "strong" | "weak" } | null;
  merchantTypeMixed?: string | null;
  spellings: PayeeGroupRow[];
  pending: { total: number; byTable: Record<string, number>; changes: Array<{ from: string; to: string; count: number }> };
  history: BatchRow[];
  categories: Array<{ id: number; name: string }>;
  currency: string;
  kpis?: {
    currency: string;
    window: { from: string; to: string; months: number };
    total: number;
    spend: number;
    count: number;
    average: number;
    lastDate: string | null;
    months: Array<{ month: string; total: number }>;
    recent: Array<{ id: number; date: string; amount: number; currency: string | null; account: string | null; category: string | null; payee: string }>;
    uncategorized?: number;
    truncated: boolean;
  };
};
type Rule = { id: number; name: string; conditions: { all?: Array<{ field?: string; op?: string; value?: string }> } };

/** Requisite kinds when the settings have not loaded yet. */
const IDENTIFIER_KINDS = ["iban", "tax_id", "edrpou", "card_last4", "crypto_wallet"];
const SOURCE_LABEL: Record<string, StudioTextKey> = {
  canonical: "profile.source.canonical",
  rename: "profile.source.rename",
  merge: "profile.source.merge",
  split: "profile.source.split",
  rule: "profile.source.rule",
  proposal: "profile.source.proposal",
  manual: "profile.source.manual",
};

type Action = { title: string; body: Record<string, unknown> | null; confirm?: string; then?: "back" };

export default function PayeeEntityPage() {
  const t = useStudioT();
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
  const kinds = settings?.identifierKinds ?? IDENTIFIER_KINDS;

  const undoToast = useUndoToast(async (n) => {
    setStatus(t("common.undone", { n }));
    await mutate();
  });

  async function done(r: OpPreview, then?: "back") {
    setAction(null);
    setEdit(null);
    setSplitIds(new Set());
    setNewAlias({ pattern: "", mode: "exact" });
    if (then === "back") {
      router.push("/merchants");
      return;
    }
    const text = r.undo ? t("common.undone", { n: r.undo.restoredRows }) : t("common.saved", { rows: describeRows(r, t) });
    // P8 stage 3: «Готово · Скасувати» for 10 s after a confirmed change.
    if (r.batchId && !r.undo && r.op !== "undo") {
      setStatus("");
      undoToast.show(r.batchId, text);
    } else setStatus(text);
    await mutate();
  }

  if (error && !data) return <LoadError message={t("profile.loadFailed")} onRetry={() => void mutate()} />;
  if (!data || !e) return <ListSkeleton />;

  const types = data.merchantTypes ?? [];
  const currentType = e.merchantTypeId == null ? null : (types.find((x) => x.id === e.merchantTypeId) ?? null);
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
        <Link href="/merchants" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="h-3 w-3" /> {t("page.title")}
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
              title: v ? t("profile.typeTitle", { type: merchantTypeLabel(v, t) }) : t("profile.typeClear"),
              body: { op: "update", entityId: e.id, merchantType: v, apply: false },
              confirm: t("common.save"),
            });
          return (
            <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
              <span className="text-muted-foreground">{t("types.merchantType")}:</span>
              <MerchantTypeSelect types={types} value={current} onChange={setType} />
              {hint && (
                <Button size="sm" variant="outline" className={`h-8 text-xs ${hint.strength === "weak" ? "opacity-70" : ""}`} title={t("common.hintTitle", { reason: hint.reason })} onClick={() => setType(hint)}>
                  {hint.strength === "weak" ? t("common.weakHint") : t("common.hint")}: {merchantTypeLabel(hint, t)}
                </Button>
              )}
              {hint?.strength === "weak" && <span className="text-xs text-muted-foreground">({hint.reason})</span>}
              {!current && data.merchantTypeMixed && <span className="text-xs text-amber-600 dark:text-amber-400">{data.merchantTypeMixed}</span>}
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
            {t("common.edit")}
          </Button>
          <Link href={buildTxDrillUrl({ search: e.name })}>
            <Button size="sm" variant="outline">{t("common.transactions")}</Button>
          </Link>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => setAction({ title: t("profile.removeTitle", { name: e.name }), body: { op: "delete", entityId: e.id }, confirm: t("common.remove"), then: "back" })}
          >
            {t("common.remove")}
          </Button>
        </div>
        <p className="mt-2 text-sm">
          <span className="text-muted-foreground">{t("profile.defaultCategoryShort")}:</span>{" "}
          {data.categories.find((c) => c.id === e.defaultCategoryId)?.name ?? <span className="text-muted-foreground">{t("profile.none")}</span>}
          <HelpHint text={t("profile.defaultCategory")} className="ms-1" />
        </p>
        {status && <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-2">{status}</p>}
      </div>

      {data.kpis && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("profile.kpi.title", { n: data.kpis.window.months })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" aria-label={t("profile.kpi.title", { n: data.kpis.window.months })}>
              <div>
                <dt className="text-xs text-muted-foreground">{t("profile.kpi.total")}</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatCurrency(data.kpis.total, data.kpis.currency)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("profile.kpi.count")}</dt>
                <dd className="text-lg font-semibold tabular-nums">{data.kpis.count}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("profile.kpi.average")}</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatCurrency(data.kpis.average, data.kpis.currency)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("profile.kpi.last")}</dt>
                <dd className="text-lg font-semibold tabular-nums">{data.kpis.lastDate ? formatDate(data.kpis.lastDate) : "—"}</dd>
              </div>
            </dl>
            {data.kpis.count > 0 ? (
              <div className="flex flex-wrap items-center gap-3">
                <Sparkline
                  values={data.kpis.months.map((m) => Math.abs(m.total))}
                  label={t("profile.kpi.spark", { list: data.kpis.months.map((m) => `${m.month}: ${formatCurrency(m.total, data.kpis!.currency)}`).join(", ") })}
                  width={200}
                />
                <span className="text-xs text-muted-foreground">
                  {data.kpis.months[0]?.month} → {data.kpis.months[data.kpis.months.length - 1]?.month}
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("profile.kpi.none")}</p>
            )}
            {data.kpis.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t("profile.kpi.truncated")}</p>}
          </CardContent>
        </Card>
      )}

      {data.kpis && data.kpis.recent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("profile.recent")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-lg border text-sm">
              {data.kpis.recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 p-2">
                  <span className="text-xs tabular-nums text-muted-foreground">{formatDate(r.date)}</span>
                  <span className="min-w-0 flex-1 truncate">{r.payee}</span>
                  {r.category && <span className="text-xs text-muted-foreground">{r.category}</span>}
                  {r.account && <span className="text-xs text-muted-foreground">{r.account}</span>}
                  <span className="tabular-nums">{formatCurrency(r.amount, r.currency ?? currency)}</span>
                </li>
              ))}
            </ul>
            <Link href={buildTxDrillUrl({ search: e.name })} className="mt-2 inline-block text-xs underline">
              {t("profile.allTransactions")}
            </Link>
          </CardContent>
        </Card>
      )}

      {edit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("profile.editTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input aria-label={t("common.canonicalName")} value={edit.name} onChange={(ev) => setEdit({ ...edit, name: ev.target.value })} />
            <MerchantTypeSelect types={types} value={edit.merchantType} onChange={(v) => setEdit({ ...edit, merchantType: v })} className="h-9 w-full rounded-md border bg-background px-2 text-sm" />
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">{t("common.moreEntryType", { type: typeLabel(edit.type, t) })}</summary>
              <label className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t("common.entryType")}</span>
                <select aria-label={t("common.type")} className="h-8 rounded-md border bg-background px-2 text-sm" value={edit.type} onChange={(ev) => setEdit({ ...edit, type: ev.target.value })}>
                  {PAYEE_TYPE_OPTIONS.map((x) => (
                    <option key={x} value={x}>{typeLabel(x, t)}</option>
                  ))}
                </select>
              </label>
              <p className="mt-1 text-muted-foreground">{t("profile.personsNote")}</p>
            </details>
            <textarea
              aria-label={t("profile.note")}
              className="w-full min-h-16 rounded-md border bg-background p-2 text-sm"
              placeholder={t("profile.notePlaceholder")}
              value={edit.note}
              onChange={(ev) => setEdit({ ...edit, note: ev.target.value })}
            />
            <label className="block text-xs text-muted-foreground">
              {t("profile.defaultCategory")}
              <select className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" value={edit.categoryId} onChange={(ev) => setEdit({ ...edit, categoryId: ev.target.value })}>
                <option value="">{t("profile.none")}</option>
                {data.categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEdit(null)}>{t("common.cancel")}</Button>
              <Button size="sm" disabled={!editChanged} onClick={() => setAction({ title: t("profile.saveChanges"), body: editBody, confirm: t("common.save") })}>
                {t("profile.reviewChanges")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("profile.renameNote")}</p>
          </CardContent>
        </Card>
      )}

      {data.pending.total > 0 && (
        <Card>
          <CardContent className="pt-6 flex flex-wrap items-center gap-2 text-sm">
            <span>
              {t("profile.pending", { n: data.pending.total, list: `${data.pending.changes.slice(0, 3).map((c) => `“${c.from}”`).join(", ")}${data.pending.changes.length > 3 ? ", …" : ""}` })}
            </span>
            <Button size="sm" className="ms-auto" onClick={() => setAction({ title: t("common.renameTo", { name: e.name }), body: { op: "apply", entityIds: [e.id] }, confirm: t("common.rename") })}>
              {t("profile.applyNow")}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("profile.websiteLogo")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">{t("profile.website")}</span>
            {website === null ? (
              <>
                {e.website ? <WebsiteLink url={e.website} /> : <span className="text-xs text-muted-foreground">{t("profile.none")}</span>}
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setWebsite(e.website ?? "")}>
                  {e.website ? t("profile.change") : t("common.add")}
                </Button>
                {e.website && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => setAction({ title: t("profile.removeWebsite"), body: { op: "update", entityId: e.id, website: null, apply: false }, confirm: t("common.remove") })}>
                    {t("common.remove")}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Input className="max-w-sm" aria-label={t("profile.website")} placeholder="example.com" value={website} onChange={(ev) => setWebsite(ev.target.value)} />
                <Button
                  size="sm"
                  disabled={!website.trim()}
                  onClick={() => {
                    setAction({ title: t("profile.saveWebsite"), body: { op: "update", entityId: e.id, website: website.trim(), apply: false }, confirm: t("common.save") });
                    setWebsite(null);
                  }}
                >
                  {t("common.saveEllipsis")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setWebsite(null)}>{t("common.cancel")}</Button>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">{t("profile.logo")}</span>
            {e.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={e.logo} alt={t("profile.logoAlt", { name: e.name })} className="h-10 w-10 rounded border object-contain bg-white" />
            ) : (
              <span className="text-xs text-muted-foreground">{t("profile.none")}</span>
            )}
            <label className="inline-flex cursor-pointer items-center rounded-md border px-2 py-1 text-xs hover:bg-accent">
              {e.logo ? t("profile.replace") : t("profile.upload")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                aria-label={t("profile.logoFile")}
                onChange={(ev) => {
                  const file = ev.target.files?.[0];
                  ev.target.value = "";
                  setLogoError("");
                  if (!file) return;
                  if (!LOGO_TYPES.includes(file.type)) return setLogoError(t("profile.logoType"));
                  if (file.size > LOGO_MAX_BYTES) return setLogoError(t("profile.logoSize", { kb: Math.ceil(file.size / 1024) }));
                  const reader = new FileReader();
                  reader.onload = () => setAction({ title: t("profile.saveLogo"), body: { op: "update", entityId: e.id, logo: String(reader.result), apply: false }, confirm: t("common.save") });
                  reader.readAsDataURL(file);
                }}
              />
            </label>
            {e.logo && (
              <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => setAction({ title: t("profile.removeLogo"), body: { op: "update", entityId: e.id, logo: null, apply: false }, confirm: t("common.remove") })}>
                {t("common.remove")}
              </Button>
            )}
          </div>
          {logoError && <p className="text-xs text-destructive">{logoError}</p>}
          <p className="text-xs text-muted-foreground">{t("profile.logoNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("profile.aliases")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t("profile.aliasesNote")}</p>
          <ul className="divide-y rounded-lg border">
            {e.aliases.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                {a.source !== "canonical" && (
                  <input
                    type="checkbox"
                    aria-label={t("profile.selectForSplit", { name: a.pattern })}
                    checked={splitIds.has(a.id)}
                    onChange={() => setSplitIds((prev) => { const n = new Set(prev); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })}
                  />
                )}
                <span className="break-all">{a.pattern}</span>
                {a.mode !== "exact" && <Badge variant="secondary">{a.mode}</Badge>}
                <span className="text-xs text-muted-foreground">{SOURCE_LABEL[a.source] ? t(SOURCE_LABEL[a.source]) : a.source}</span>
                {a.source !== "canonical" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ms-auto h-7 text-xs text-destructive"
                    onClick={() => setAction({ title: t("profile.removeAlias", { name: a.pattern }), body: { op: "alias_remove", entityId: e.id, aliasIds: [a.id] }, confirm: t("common.remove") })}
                  >
                    {t("common.remove")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {splitIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <span className="text-sm">{t("profile.splitLabel", { n: splitIds.size })}</span>
              <Input className="max-w-xs" aria-label={t("profile.newPayeeName")} placeholder={t("profile.newPayeeName")} value={splitName} onChange={(ev) => setSplitName(ev.target.value)} />
              <Button
                size="sm"
                disabled={!splitName.trim()}
                onClick={() => setAction({ title: t("profile.splitTitle", { name: splitName.trim() }), body: { op: "split", entityId: e.id, aliasIds: [...splitIds], name: splitName.trim() }, confirm: t("profile.split") })}
              >
                {t("profile.splitEllipsis")}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input className="flex-1 min-w-48" aria-label={t("profile.newAlias")} placeholder={t("profile.newAliasPlaceholder")} value={newAlias.pattern} onChange={(ev) => setNewAlias({ ...newAlias, pattern: ev.target.value })} />
            <select aria-label={t("profile.aliasMode")} className="h-9 rounded-md border bg-background px-2 text-sm" value={newAlias.mode} onChange={(ev) => setNewAlias({ ...newAlias, mode: ev.target.value })}>
              <option value="exact">{t("profile.mode.exact")}</option>
              <option value="contains">{t("profile.mode.contains")}</option>
              <option value="regex">{t("profile.mode.regex")}</option>
            </select>
            <Button
              size="sm"
              disabled={!newAlias.pattern.trim()}
              onClick={() => setAction({ title: t("profile.addAlias", { name: newAlias.pattern.trim() }), body: { op: "alias_add", entityId: e.id, aliases: [{ pattern: newAlias.pattern.trim(), mode: newAlias.mode }] }, confirm: t("common.add") })}
            >
              {t("common.addEllipsis")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRulesOpen((v) => !v)}>
              {t("profile.fromRule")}
            </Button>
          </div>
          {rulesOpen && (
            <div className="rounded-md border p-2 text-sm space-y-1">
              {!rules ? (
                <p className="text-xs text-muted-foreground">{t("profile.loadingRules")}</p>
              ) : payeeRules.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("profile.noRules")}</p>
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
                      className="ms-auto h-7 text-xs"
                      onClick={() => setAction({ title: t("profile.fromRuleTitle", { name: r.name }), body: { op: "alias_from_rule", ruleId: r.id, entityId: e.id }, confirm: t("common.add") })}
                    >
                      {t("profile.use")}
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <MerchantRulesCard
        entity={{ id: e.id, name: e.name }}
        merchantTypeId={e.merchantTypeId ?? null}
        defaultCategoryId={e.defaultCategoryId ?? currentType?.defaultCategoryId ?? null}
        uncategorized={data.kpis?.uncategorized ?? null}
        onApplyCategory={() => setAction({ title: t("merchantRules.applyTitle", { name: e.name }), body: { op: "apply_default_category", entityId: e.id }, confirm: t("common.apply") })}
      />

      {(advanced || e.identifiers.length > 0) && (
        <RequisitesCard
          readOnly={!advanced}
          entityId={e.id}
          entityType={e.type}
          requisites={e.identifiers}
          allowedKinds={kinds}
          onAction={(a) => setAction({ title: a.title, body: a.body, confirm: a.confirm })}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("profile.storedSpellings")}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.spellings.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("profile.noSpellings")}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.spellings.flatMap((g) =>
                g.spellings.map((s) => (
                  <li key={`${g.key}|${s.spelling}`} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                    <span className="break-all">{s.spelling}</span>
                    <span className="ms-auto text-xs text-muted-foreground tabular-nums">× {s.count}</span>
                    {s.spelling !== e.name && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        title={t("quick.makeMainTitle")}
                        onClick={() => setAction({ title: t("quick.makeMainConfirmTitle", { name: s.spelling }), body: { op: "update", entityId: e.id, name: s.spelling }, confirm: t("quick.makeMain") })}
                      >
                        {t("quick.makeMain")}
                      </Button>
                    )}
                  </li>
                )),
              )}
              <li className="p-2 text-xs text-muted-foreground tabular-nums">
                {t("profile.transactionsCount", { n: data.spellings.reduce((n, g) => n + g.count, 0) })} · {formatCurrency(data.spellings.reduce((n, g) => n + g.total, 0), currency)}
              </li>
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("profile.history")}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.history.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("common.noChanges")}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.history.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                  <span className="font-medium">#{b.id}</span>
                  <span>{batchLabel(b, t)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{b.createdAt.slice(0, 16).replace("T", " ")}</span>
                  <span className="ms-auto">
                    {b.undoneAt ? (
                      <span className="text-xs text-muted-foreground">{t("common.undoneBadge")}</span>
                    ) : b.canUndo ? (
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAction({ title: t("common.undoTitle", { id: b.id }), body: { op: "undo", batchId: b.id }, confirm: t("common.undo") })}>
                        {t("common.undo")}
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {undoToast.node}
      {action && (
        <OpDialog title={action.title} body={action.body} confirmLabel={action.confirm} onClose={() => setAction(null)} onDone={(r) => done(r, action.then)} />
      )}
    </div>
  );
}
