"use client";

/**
 * AI & API access (S3) — the API key card and a short MCP activity journal.
 *
 * Both read GET /api/settings/ai-access, which never creates a key (unlike
 * GET /api/settings/api-key). Regenerate goes through the existing
 * POST /api/settings/api-key and shows the new raw key once.
 *
 * The journal is deliberately short: the newest ~100 MCP tool calls (90-day
 * retention) with an "only writes" filter, plus a per-client summary for the
 * last 7 days. It never shows tool arguments — the server doesn't store them.
 */

import { useState } from "react";
import useSWR from "swr";
import { jsonFetcher } from "@/lib/swr";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { parseSaveError } from "@/lib/save-error";
import { Activity, KeyRound, Loader2 } from "lucide-react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";

type AiAccess = {
  apiKey: { exists: boolean; createdAt: string | null; hasDekWrap: boolean; lastActivityAt: string | null };
  clients: Array<{ client: string; lastActivityAt: string | null; calls7d: number; writes7d: number }>;
  events: Array<{
    id: number;
    client: string;
    tool: string;
    op: string | null;
    isWrite: boolean;
    ok: boolean;
    errorCode: string | null;
    affectedCount: number | null;
    createdAt: string | null;
  }>;
  journalAvailable: boolean;
  /** P8 stage 9 (B12): which connector schema this server answers with. */
  schema?: { serverVersion: string; tools: { http: number; stdio: number }; payees: string };
};

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDay(iso: string | null): string {
  if (!iso) return "Unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function AiAccess() {
  const t = useT();
  const [writesOnly, setWritesOnly] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<AiAccess>(
    `/api/settings/ai-access${writesOnly ? "?writesOnly=1" : ""}`,
    jsonFetcher,
    { revalidateOnFocus: false, keepPreviousData: true },
  );

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function regenerate() {
    setRegenerating(true);
    setRegenError("");
    try {
      const res = await fetch("/api/settings/api-key", { method: "POST" });
      if (!res.ok) {
        setRegenError(await parseSaveError(res, "Failed to regenerate the API key"));
        return;
      }
      const body = (await res.json()) as { apiKey?: string };
      setNewKey(body.apiKey ?? null);
      setCopied(false);
      setConfirmOpen(false);
      await mutate();
    } catch {
      setRegenError("Failed to regenerate the API key");
    } finally {
      setRegenerating(false);
    }
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const key = data?.apiKey;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100 text-sky-600">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">API key</CardTitle>
              <CardDescription>For MCP clients and scripts that connect with a key instead of OAuth.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {isLoading && !data ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : error ? (
            <p className="text-destructive">Couldn&apos;t load the API key status.</p>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  {key?.exists ? (
                    <Badge variant="secondary">Active</Badge>
                  ) : (
                    <Badge variant="outline">No key</Badge>
                  )}
                  {key?.exists && !key.hasDekWrap && (
                    <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">
                      Can&apos;t read encrypted data — regenerate it while signed in.
                    </span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{key?.exists ? formatDay(key.createdAt) : "—"}</dd>
                <dt className="text-muted-foreground">Last MCP activity</dt>
                <dd>{formatWhen(key?.lastActivityAt ?? null)}</dd>
                {data?.schema && (
                  <>
                    <dt className="text-muted-foreground">{t("aiAccess.schemaTitle")}</dt>
                    <dd data-testid="mcp-schema">
                      {t("aiAccess.schemaLine", { version: data.schema.serverVersion, http: data.schema.tools.http, stdio: data.schema.tools.stdio, payees: data.schema.payees })}
                      {" · "}
                      <Link href="/merchants?tab=changes" className="underline">{t("aiAccess.batchesLink")}</Link>
                    </dd>
                  </>
                )}
              </dl>
              {newKey && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2 dark:border-amber-800 dark:bg-amber-950/30">
                  <p className="font-medium">Copy your new key now — it won&apos;t be shown again.</p>
                  <div className="flex gap-2">
                    <Input readOnly value={newKey} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                    <Button variant="outline" size="sm" onClick={copyKey}>{copied ? "Copied" : "Copy"}</Button>
                  </div>
                </div>
              )}
              {regenError && !confirmOpen && <p className="text-destructive">{regenError}</p>}
              <Button variant="outline" size="sm" onClick={() => { setRegenError(""); setConfirmOpen(true); }}>
                {key?.exists ? "Regenerate key" : "Create key"}
              </Button>
            </>
          )}
        </CardContent>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(o) => { if (!o) setConfirmOpen(false); }}
          title={key?.exists ? "Regenerate API key" : "Create API key"}
          description={
            <div className="space-y-2">
              {key?.exists && <p>The current key stops working immediately. Anything using it must be updated.</p>}
              <p>The new key is shown once.</p>
              {regenError && <p className="text-destructive">{regenError}</p>}
            </div>
          }
          confirmLabel={key?.exists ? "Regenerate" : "Create"}
          busyLabel="Working…"
          busy={regenerating}
          onConfirm={regenerate}
        />
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">AI activity</CardTitle>
              <CardDescription>
                Recent MCP tool calls by connected apps and your API key. Only the tool and outcome are kept, never what was
                sent; entries are deleted after 90 days.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {data && !data.journalAvailable ? (
            <p className="text-muted-foreground">Activity logging isn&apos;t set up on this server yet.</p>
          ) : (
            <>
              <section>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Last 7 days by client</h4>
                {!data ? null : data.clients.length === 0 ? (
                  <p className="text-muted-foreground">No MCP activity yet.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-xl border">
                    {data.clients.map((c) => (
                      <li key={c.client} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                        <span className="font-medium truncate">{c.client}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {c.calls7d} calls · {c.writes7d} writes · last {formatWhen(c.lastActivityAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recent calls</h4>
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={writesOnly} onChange={(e) => setWritesOnly(e.target.checked)} />
                    Only writes
                  </label>
                </div>
                {!data ? null : data.events.length === 0 ? (
                  <p className="text-muted-foreground">{writesOnly ? "No writes yet." : "No calls yet."}</p>
                ) : (
                  <ul className="divide-y divide-border rounded-xl border max-h-96 overflow-y-auto">
                    {data.events.map((e) => (
                      <li key={e.id} className="px-4 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs">{e.tool}{e.op ? ` · ${e.op}` : ""}</span>
                          {e.isWrite && <Badge variant="secondary" className="text-[10px]">write</Badge>}
                          {!e.ok && (
                            <Badge variant="outline" className="text-[10px] border-destructive/50 text-destructive">
                              failed{e.errorCode ? ` (${e.errorCode})` : ""}
                            </Badge>
                          )}
                          {e.affectedCount != null && (
                            <span className="text-xs text-muted-foreground tabular-nums">{e.affectedCount} affected</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {e.client} · {formatWhen(e.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
