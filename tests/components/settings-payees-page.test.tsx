/**
 * @vitest-environment jsdom
 *
 * Settings → Payees (Payee Studio P1): All / Clusters / Unrecognized tabs,
 * spellings badge, needs-decision flag for people.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import PayeesSettingsPage from "@/app/(app)/settings/payees/page";

const base = {
  rows: 0, sources: {}, firstDate: "2026-01-01", lastDate: "2026-09-01", accounts: [], categories: [],
  noisy: false, entityId: null, entityName: null,
};
const groups = [
  {
    ...base, key: "epikentr", name: "Епіцентр", suggestedName: "Епіцентр", count: 28, rows: 30, total: -10860,
    spellings: [{ spelling: "Епіцентр", count: 21 }, { spelling: "Epicentr", count: 6 }, { spelling: "EPITCENTR K10 KYIV 360616", count: 4 }],
    noisy: true, type: { type: "retail", confidence: 0.6, isPerson: false, reason: "shop" },
  },
  {
    ...base, key: "epikentr k", name: "Епіцентр К", suggestedName: "Епіцентр К", count: 2, rows: 2, total: -1998,
    spellings: [{ spelling: "Епіцентр К", count: 2 }], type: { type: "retail", confidence: 0.6, isPerson: false, reason: "shop" },
  },
  {
    ...base, key: "derkach oleksandr petrovich", name: "Деркач Олександр Петрович", suggestedName: "Деркач Олександр Петрович", count: 5, rows: 5, total: -7500,
    spellings: [{ spelling: "Деркач Олександр Петрович", count: 4 }, { spelling: "DERKACH OLEKSANDR PETROVYCH", count: 1 }],
    type: { type: "person", confidence: 0.85, isPerson: true, reason: "full name with a patronymic" },
  },
];
const clusters = [
  {
    id: "c_1", keys: ["epikentr", "epikentr k"], confidence: 0.9, reasons: ["same name apart from a one-letter suffix or legal form"],
    needsDecision: false, decisionReason: null, suggestedName: "Епіцентр", suggestedType: groups[0].type, count: 30, total: -12858, spellingCount: 4,
  },
  {
    id: "c_2", keys: ["derkach oleksandr petrovich"], confidence: 0.95, reasons: ["same name: Latin / Cyrillic transliteration"],
    needsDecision: true, decisionReason: "Looks like a private person", suggestedName: "Деркач Олександр Петрович", suggestedType: groups[2].type, count: 5, total: -7500, spellingCount: 2,
  },
];

const preview = {
  op: "merge", batchId: null, entity: { id: 1, name: "Епіцентр", type: "retail" }, created: true,
  aliasesAdded: [{ pattern: "Епіцентр К", mode: "exact" }], aliasesRemoved: 0, identifiersAdded: [], identifiersRemoved: 0, entitiesRemoved: 0,
  rows: { total: 12, byTable: { transactions: 10, recurring: 1, staged: 1 }, changes: [{ from: "Epicentr", to: "Епіцентр", count: 6 }], conflicts: [], truncated: false },
  warnings: [], blocked: null,
};
const batches = [
  { id: 7, kind: "merge", actor: "mcp", summary: { rows: 12 }, entityIds: [1], createdAt: "2026-10-11T10:00:00Z", expiresAt: "2026-11-10T10:00:00Z", undoneAt: null, canUndo: true },
];

function setup() {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url === "/api/payees" && body) return { ok: true, json: async () => ({ ...preview, dryRun: body.dryRun === true }) };
    if (url.startsWith("/api/payees/insights")) {
      const cp = { id: "e:1", name: "Епіцентр", entityId: 1, count: 28, total: -10860, spend: 10860, firstDate: "2026-01-01", lastDate: "2026-09-01" };
      return {
        ok: true,
        json: async () => ({
          currency: "UAH", window: { months: 12, from: "2025-10-01" },
          totals: { counterparties: 5, transactions: 40, spend: 15000, income: 0 },
          topBySpend: [cp], topByCount: [cp],
          monthly: { months: ["2026-08", "2026-09"], series: [{ id: "e:1", name: "Епіцентр", values: [-500, -700] }, { id: "other", name: "Everyone else", values: [-100, 0] }] },
          newCounterparties: [], goneCounterparties: [],
          recurring: [{ ...cp, intervalDays: 30, cadence: "monthly", nextExpected: "2026-10-01", typicalAmount: -390 }],
          concentration: { top5Share: 0.91, top10Share: 1, hhi: 5600, label: "high" },
        }),
      };
    }
    if (url.startsWith("/api/payees")) {
      return {
        ok: true,
        json: async () => ({
          groups, totalGroups: 3, clusters, currency: "UAH", truncated: [], undecryptable: 0,
          entities: [], batches, settings: { advancedMode: false, identifierKinds: [] },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PayeesSettingsPage />
    </SWRConfig>,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings → Payees", () => {
  it("lists payees with their spellings and flags people", async () => {
    setup();
    expect((await screen.findAllByText("Епіцентр")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("3 spellings").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Needs decision").length).toBeGreaterThan(0);
  });

  it("shows clusters with confidence and reasons", async () => {
    setup();
    await screen.findAllByText("Епіцентр");
    fireEvent.click(screen.getByRole("tab", { name: /Clusters/ }));
    expect(screen.getAllByTitle("How sure the match is")[0].textContent).toBe("90%");
    expect(screen.getByText(/one-letter suffix/)).toBeTruthy();
    expect(screen.getByText("Looks like a private person")).toBeTruthy();
  });

  it("filters by search across spellings", async () => {
    setup();
    await screen.findAllByText("Епіцентр");
    fireEvent.change(screen.getByPlaceholderText("Search payees…"), { target: { value: "derkach" } });
    expect(screen.queryAllByText("Епіцентр К")).toHaveLength(0);
    expect(screen.getAllByText("Деркач Олександр Петрович").length).toBeGreaterThan(0);
  });

  it("merges a cluster after a preview of the rows it renames", async () => {
    const calls = setup();
    await screen.findAllByText("Епіцентр");
    fireEvent.click(screen.getByRole("tab", { name: /Clusters/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Merge…" })[0]);
    expect(await screen.findByText(/Renames 12 rows: 10 in transactions, 1 in recurring transactions, 1 in staged imports/)).toBeTruthy();
    const dry = calls.find((c) => c.body?.dryRun === true)!;
    expect(dry.body).toMatchObject({ op: "merge", into: { name: "Епіцентр", type: "retail" } });
    expect((dry.body!.payees as string[]).sort()).toEqual(["EPITCENTR K10 KYIV 360616", "Epicentr", "Епіцентр", "Епіцентр К"].sort());
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(calls.some((c) => c.body && c.body.op === "merge" && c.body.dryRun === undefined)).toBe(true));
  });

  it("lists change batches with Undo", async () => {
    setup();
    await screen.findAllByText("Епіцентр");
    fireEvent.click(screen.getByRole("tab", { name: /Changes/ }));
    expect(screen.getByText(/Merged · 12 rows · by AI \(MCP\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("shows insights: concentration, monthly spend and regular counterparties", async () => {
    setup();
    await screen.findAllByText("Епіцентр");
    fireEvent.click(screen.getByRole("tab", { name: /Insights/ }));
    expect(await screen.findByText("91%")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Spend per month/ })).toBeTruthy();
    expect(screen.getByText(/monthly · ~30 days/)).toBeTruthy();
  });
});
