/**
 * @vitest-environment jsdom
 *
 * Settings → Payees → Bulk fill (P6.2, item 82 / B28): unticked rows stay
 * out of the set, edited names and a confirmed hint are sent, the hint is
 * never sent unless clicked, and one preview precedes one commit.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { BulkPanel } from "@/app/(app)/merchants/_components/bulk-panel";

const row = (rowId: string, name: string, hint: { group: string; name: string; reason: string } | null = null) => ({
  rowId,
  keys: [name.toLowerCase()],
  name,
  merchantTypeHint: hint,
  spellings: [{ spelling: name, count: 3 }, { spelling: name.toUpperCase(), count: 2 }],
  rows: 5,
  transactions: 5,
  confidence: 0.95,
  source: "cluster",
});

function setup() {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url === "/api/payees/settings") return { ok: true, json: async () => ({ language: "en" }) };
    if (url.startsWith("/api/payees/bulk") && !body) {
      return {
        ok: true,
        json: async () => ({
          threshold: 0.9,
          max: 300,
          left: { belowThreshold: 1, needsDecision: 2 },
          people: [],
          rows: [row("c1", "Okko", { group: "Транспорт", name: "Пальне (АЗС)", reason: "слово-тип «азс»" }), row("c2", "Silpo"), row("g_3", "Kavarnia Lviv")],
        }),
      };
    }
    const n = (body?.items as unknown[] | undefined)?.length ?? 0;
    return {
      ok: true,
      json: async () => ({
        op: "bulk", dryRun: body?.dryRun === true, batchId: body?.dryRun ? null : 7, entity: null, created: true, aliasesAdded: [], aliasesRemoved: 0, identifiersAdded: [], identifiersRemoved: 0, entitiesRemoved: 0,
        rows: { total: 0, byTable: { transactions: 0, recurring: 0, staged: 0 }, changes: [], conflicts: [], truncated: false },
        warnings: [], blocked: null,
        bulk: { entities: [], created: n, createdIds: body?.dryRun ? [] : [1, 2], pendingRows: 4 },
      }),
    };
  }));
  const onDone = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BulkPanel types={[{ id: 1, group: "Транспорт", name: "Пальне (АЗС)" }]} onDone={onDone} />
    </SWRConfig>,
  );
  return { calls, onDone };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings → Payees → Bulk fill", () => {
  it("sends only ticked rows, edited names and confirmed types; one preview, then one commit", async () => {
    const { calls, onDone } = setup();
    expect(await screen.findByDisplayValue("Okko")).toBeTruthy();
    expect(screen.getByText("3 of 3 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select “Silpo”" }));
    expect(screen.getByText("2 of 3 selected")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name for “Kavarnia Lviv”"), { target: { value: "Кавʼярня Львів" } });
    fireEvent.click(screen.getByRole("button", { name: /Hint: Транспорт → Пальне/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create entries…" }));
    expect(await screen.findByText(/Creates 2 entries/)).toBeTruthy();
    const preview = calls.find((c) => c.body?.dryRun === true)!;
    expect(preview.url).toBe("/api/payees/bulk");
    expect(preview.body).toEqual({
      items: [{ rowId: "c1", merchantType: { group: "Транспорт", name: "Пальне (АЗС)" } }, { rowId: "g_3", name: "Кавʼярня Львів" }],
      dryRun: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/Created 2 entries\. 4 rows to rename next/)).toBeTruthy();
    expect(calls.filter((c) => c.url === "/api/payees/bulk" && c.body && c.body.dryRun === undefined)).toHaveLength(1);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Rename rows (Apply)…" })).toBeTruthy();
  });

  it("never sends a type hint the person did not click", async () => {
    const { calls } = setup();
    await screen.findByDisplayValue("Okko");
    fireEvent.click(screen.getByRole("button", { name: "Create entries…" }));
    await screen.findByText(/Creates 3 entries/);
    const items = calls.find((c) => c.body?.dryRun === true)!.body!.items as Array<Record<string, unknown>>;
    expect(items.every((i) => !("merchantType" in i))).toBe(true);
  });
});
