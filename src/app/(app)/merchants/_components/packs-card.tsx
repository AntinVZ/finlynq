"use client";

/**
 * «Словники і пакети» → country packs (P8 stage 7): which packs are in
 * force and what each brings (type words, bank operations, channels,
 * merchant types, MCC, ID types, transliteration); turn the EU pack on or
 * off; import a pack JSON (preview first), export any pack; check a
 * requisite against the ID types of the packs in force. The value checked
 * is sent once and never stored.
 */

import { useRef, useState } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import { ActionButton } from "@/components/actions/action-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/client";

type PackRow = {
  id: string;
  name: string;
  country: string;
  locale: string;
  builtin: boolean;
  active: boolean;
  typeWords: number;
  bankOperations: number;
  channels: number;
  merchantTypes: number;
  mcc: number;
  idTypes: Array<{ id: string; label: string; known: boolean }>;
  transliteration: Array<{ id: string; available: boolean }>;
  unknownTypeCodes: string[];
};
type PacksData = { packs: PackRow[]; idTypes: Array<{ id: string; label: string; country: string; person: boolean; example: string }>; translit: Array<{ id: string; script: string; matching: boolean }> };
type Match = { id: string; label: string; country: string; person: boolean; check: { ok: boolean; reason?: string }; masked: string };

async function post(body: unknown) {
  const res = await fetch("/api/payees/packs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  return { ok: Boolean(res?.ok), data: res ? await res.json().catch(() => ({})) : {} };
}

export function PacksCard({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const { data, error, mutate } = useSWR<PacksData>("/api/payees/packs", jsonFetcher, { revalidateOnFocus: false });
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<{ pack: unknown; summary: PackRow; replaces: boolean } | null>(null);
  const [value, setValue] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const packs = Array.isArray(data?.packs) ? data!.packs : [];

  async function toggle(p: PackRow) {
    const r = await post({ action: p.active ? "disable" : "enable", id: p.id });
    setStatus(r.ok ? t("packs.saved") : t("packs.failed"));
    await mutate();
    onChanged?.();
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    let pack: unknown;
    try {
      pack = JSON.parse(await f.text());
    } catch {
      setStatus(t("packs.notJson"));
      return;
    }
    const r = await post({ action: "import", pack, dryRun: true });
    if (!r.ok) {
      const errs = (r.data as { errors?: Array<{ path: string; message: string }> }).errors ?? [];
      setStatus(t("packs.invalid", { list: errs.map((e) => `${e.path || "—"}: ${e.message}`).join("; ") }));
      return;
    }
    setPreview({ pack, summary: { ...(r.data as { preview: PackRow }).preview, active: true }, replaces: Boolean((r.data as { replaces?: boolean }).replaces) });
  }

  async function confirmImport() {
    if (!preview) return;
    const r = await post({ action: "import", pack: preview.pack });
    setPreview(null);
    setStatus(r.ok ? t("packs.imported") : t("packs.failed"));
    await mutate();
    onChanged?.();
  }

  async function remove(p: PackRow) {
    const r = await post({ action: "remove", id: p.id });
    setStatus(r.ok ? t("packs.removed") : t("packs.failed"));
    await mutate();
    onChanged?.();
  }

  async function check() {
    if (!value.trim()) return;
    const r = await post({ action: "check", value: value.trim() });
    setMatches(r.ok ? ((r.data as { matches?: Match[] }).matches ?? []) : []);
  }

  const counts = (p: PackRow) =>
    t("packs.counts", { words: p.typeWords, ops: p.bankOperations, channels: p.channels, types: p.merchantTypes, mcc: p.mcc });

  return (
    <section className="space-y-3" aria-label={t("packs.title")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t("packs.title")}</h3>
        <span className="ms-auto flex gap-1">
          <input ref={file} type="file" accept="application/json,.json" className="hidden" aria-label={t("packs.import")} onChange={(e) => void pick(e.target.files?.[0])} />
          <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
            {t("packs.import")}
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("packs.intro")}</p>
      {status && <p className="text-sm" role="status">{status}</p>}
      {error && <p className="text-sm text-destructive">{t("packs.loadFailed")}</p>}
      <ul className="grid gap-2 sm:grid-cols-2" data-testid="packs">
        {packs.map((p) => (
          <li key={p.id} className="rounded-md border p-3 text-sm space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <Badge variant="outline" className="font-normal">{p.country} · {p.locale}</Badge>
              {p.active ? <Badge variant="secondary">{t("packs.on")}</Badge> : <Badge variant="outline">{t("packs.off")}</Badge>}
              <span className="ms-auto flex gap-1">
                <a className="text-xs underline" href={`/api/payees/packs?export=${encodeURIComponent(p.id)}`}>{t("packs.export")}</a>
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{counts(p)}</p>
            <p className="text-xs">
              {t("packs.ids")}: {p.idTypes.map((i) => i.label).join(", ") || "—"}
              {p.transliteration.length > 0 && <> · {t("packs.translit")}: {p.transliteration.map((x) => `${x.id}${x.available ? "" : " ✗"}`).join(", ")}</>}
            </p>
            {p.unknownTypeCodes.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">{t("packs.unknownCodes", { list: p.unknownTypeCodes.join(", ") })}</p>}
            <div className="flex gap-1 pt-1">
              {p.id !== "ua" && p.builtin && (
                <ActionButton intent={p.active ? "neutral" : "confirm"} soft className="h-7 text-xs" onClick={() => void toggle(p)}>
                  {p.active ? t("packs.turnOff") : t("packs.turnOn")}
                </ActionButton>
              )}
              {!p.builtin && (
                <ActionButton intent="reject" soft className="h-7 text-xs" onClick={() => void remove(p)}>
                  {t("packs.remove")}
                </ActionButton>
              )}
              {p.id === "ua" && <span className="text-xs text-muted-foreground">{t("packs.alwaysOn")}</span>}
            </div>
          </li>
        ))}
      </ul>

      {preview && (
        <div className="rounded-md border border-amber-300 p-3 text-sm space-y-2 dark:border-amber-800" role="dialog" aria-label={t("packs.previewTitle")}>
          <p className="font-medium">{t("packs.previewTitle")}: {preview.summary.name} ({preview.summary.country})</p>
          <p className="text-xs">{counts(preview.summary)}</p>
          <p className="text-xs">{t("packs.ids")}: {preview.summary.idTypes.map((i) => `${i.label}${i.known ? "" : " ✗"}`).join(", ") || "—"}</p>
          {preview.replaces && <p className="text-xs text-amber-600 dark:text-amber-400">{t("packs.replaces")}</p>}
          <div className="flex gap-1">
            <ActionButton intent="confirm" className="h-7 text-xs" onClick={() => void confirmImport()}>{t("packs.confirmImport")}</ActionButton>
            <ActionButton intent="neutral" soft className="h-7 text-xs" onClick={() => setPreview(null)}>{t("common.cancel")}</ActionButton>
          </div>
        </div>
      )}

      <div className="rounded-md border p-3 space-y-2">
        <label className="text-sm font-medium" htmlFor="pack-check">{t("packs.checkTitle")}</label>
        <div className="flex flex-wrap gap-2">
          <Input id="pack-check" className="h-8 w-64 text-sm" value={value} autoComplete="off" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void check()} />
          <Button variant="outline" size="sm" onClick={() => void check()}>{t("packs.check")}</Button>
        </div>
        {matches && (
          matches.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("packs.noMatch")}</p>
          ) : (
            <ul className="text-xs space-y-0.5" data-testid="id-matches">
              {matches.map((m) => (
                <li key={m.id} className={m.check.ok ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}>
                  {m.label} ({m.country}) · {m.masked} · {m.check.ok ? t("packs.valid") : t("packs.badChecksum")}
                  {m.person ? ` · ${t("packs.person")}` : ""}
                </li>
              ))}
            </ul>
          )
        )}
      </div>

      {data && (
        <details className="rounded-md border p-3 text-xs" data-testid="id-registry">
          <summary className="cursor-pointer text-sm font-medium">{t("packs.registryTitle")}</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {(data.idTypes ?? []).map((i) => (
              <li key={i.id}>
                <span className="font-medium">{i.label}</span> ({i.country === "*" ? t("packs.anyCountry") : i.country}) · <code>{i.example}</code>
                {i.person ? ` · ${t("packs.person")}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            {t("packs.translit")}: {(data.translit ?? []).map((x) => `${x.id} (${x.script})${x.matching ? ` · ${t("packs.inMatching")}` : ""}`).join(", ")}
          </p>
        </details>
      )}
    </section>
  );
}
