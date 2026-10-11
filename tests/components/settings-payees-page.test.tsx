/**
 * @vitest-environment jsdom
 *
 * Settings → Payees (Payee Studio P1): All / Clusters / Unrecognized tabs,
 * spellings badge, needs-decision flag for people.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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

function setup() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/payees")) {
      return { ok: true, json: async () => ({ groups, totalGroups: 3, clusters, currency: "UAH", truncated: [], undecryptable: 0 }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PayeesSettingsPage />
    </SWRConfig>,
  );
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
    expect(screen.getByText("90%")).toBeTruthy();
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
});
