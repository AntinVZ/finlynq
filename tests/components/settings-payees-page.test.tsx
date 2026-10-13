/**
 * @vitest-environment jsdom
 *
 * Merchants (was Settings → Payees; Payee Studio P1, P8 stage 1): Overview /
 * Directory / Queue / Channels / Dictionaries / Changes, spellings badge,
 * needs-decision flag for people, state kept in the URL.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

vi.mock("next/navigation", async () => (await import("../helpers/next-navigation")).navigationMock);

import PayeesSettingsPage from "@/app/(app)/merchants/page";
import { navigationCalls, resetNavigation } from "../helpers/next-navigation";

beforeEach(() => resetNavigation());

/** Open a Merchants section, then (optionally) one of its views. */
function open(section: RegExp, view?: RegExp) {
  fireEvent.click(screen.getByRole("tab", { name: section }));
  if (view) fireEvent.click(screen.getByRole("tab", { name: view }));
}

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
    if (url === "/api/payees/settings") return { ok: true, json: async () => ({ language: "en" }) };
    if (url === "/api/payees" && body) return { ok: true, json: async () => ({ ...preview, dryRun: body.dryRun === true }) };
    if (url.startsWith("/api/payees/requisites?action=whose")) {
      return {
        ok: true,
        json: async () => ({
          query: { kind: "card_last4", masked: "•••• 1234", strength: "weak" }, bankRows: 0,
          hints: ["The last 4 digits 1234 belong to 2 payees; tell them apart by the typical amount, the dates and the account you paid from:"],
          candidates: [
            { entity: { id: 5, name: "Степаненко", type: "person" }, payee: "Степаненко", evidence: ["directory"], holdsRequisite: true, transactions: 2, firstDate: "2026-07-01", lastDate: "2026-08-01", totals: [{ currency: "UAH", paid: 24000, received: 0 }], typicalAmount: 12000, accounts: [{ id: 1, name: "Mono", count: 2 }], examples: [] },
            { entity: { id: 6, name: "Коваль Петро", type: "person" }, payee: "Коваль Петро", evidence: ["text"], holdsRequisite: false, transactions: 1, firstDate: "2026-08-15", lastDate: "2026-08-15", totals: [{ currency: "UAH", paid: 350, received: 0 }], typicalAmount: 350, accounts: [{ id: 2, name: "Privat", count: 1 }], examples: [{ date: "2026-08-15", amount: -350, currency: "UAH", account: "Privat", text: "Коваль Петро · •••• 1234", matchedVia: "text" }] },
          ],
        }),
      };
    }
    if (url === "/api/payees/requisites" && body) return { ok: true, json: async () => ({ saved: [{ id: 9 }], rejected: [], missing: [] }) };
    if (url.startsWith("/api/payees/requisites?action=mine")) {
      return {
        ok: true,
        json: async () => ({
          scanned: { transactions: 40, bank: 1 }, truncated: false,
          links: [{ ref: "r_link000000000000", payee: "Romashka LLC", entity: { id: 3, name: "ТОВ Ромашка" }, via: "iban UA21…6001", rows: 2 }],
          suggestions: [{ ref: "r_card000000000000", counterparty: { entityId: 5, name: "Степаненко" }, kind: "card_last4", masked: "•••• 5678", valid: true, rows: 3, firstDate: "2026-01-01", lastDate: "2026-09-01", ownedBy: [], example: "Степаненко · Переказ з картки •••• 5678" }],
        }),
      };
    }
    if (url === "/api/payees/lookalikes" && body) return { ok: true, json: async () => ({ rejected: true }) };
    if (url.startsWith("/api/payees/lookalikes")) {
      return {
        ok: true,
        json: async () => ({
          currency: "UAH", rejectedHidden: 0,
          candidates: [{
            key: "stepanenko kompensatsiia zhitla", name: "Степаненко компенсація житла", spellings: [{ spelling: "Степаненко компенсація житла", count: 2 }],
            count: 2, total: -4000, lastDate: "2026-09-15", entity: { id: 5, name: "Степаненко", type: "person" }, confidence: 0.75,
            reason: "one name continues the other", matchedAlias: "Степаненко", needsDecision: true, decisionReason: "“Степаненко” is a private person; people are never matched automatically.",
            remainder: "компенсація житла", alternatives: [],
          }],
          unrenamed: [{ entityId: 1, entityName: "Епіцентр", spellings: [{ spelling: "EPITCENTR K10 KYIV 360616", count: 1 }], rows: 1 }],
          rejections: [{ id: 3, entityId: 1, entityName: "Епіцентр", payee: "Епіцентр К", createdAt: "2026-10-12T00:00:00Z" }],
        }),
      };
    }
    if (url.startsWith("/api/payees/explain")) {
      return { ok: true, json: async () => ({ verdict: "separate", score: null, sameKey: false, reasons: ["Different first letters of the core"], a: { payee: "Rozetka", key: "rozetka", core: "rozetka", block: "roze", type: { type: "retail", reason: "", isPerson: false }, entity: null }, b: { payee: "Comfy", key: "komfi", core: "komfi", block: "komf", type: { type: "retail", reason: "", isPerson: false }, entity: null } }) };
    }
    if (url.startsWith("/api/payees/insights?view=merchants")) {
      const ref = { id: "e:1", name: "Епіцентр", entityId: 1 };
      return {
        ok: true,
        json: async () => ({
          currency: "UAH", scanned: 40, truncated: false, counterparties: 3,
          receipt: [{ ...ref, payments: 28, average: 390, median: 450, max: 999, quartiles: [300, 450, 450], histogram: [{ from: 0, to: 125, count: 2 }, { from: 125, to: 250, count: 4 }] }],
          receiptTrend: [{ ...ref, months: [{ month: "2026-08", average: 300, payments: 2 }], trendPct: 12.5 }],
          change: { period1: { from: "2026-05-01", to: "2026-07-31" }, period2: { from: "2026-08-01", to: "2026-10-12" }, rows: [{ ...ref, n1: 2, n2: 4, avg1: 300, avg2: 400, spend1: 600, spend2: 1600, countEffect: 600, receiptEffect: 400, total: 1000 }], totals: { spend1: 600, spend2: 1600, countEffect: 600, receiptEffect: 400, total: 1000 } },
          lifecycle: { new: [], quiet: [{ id: "k:x", name: "Netflix", entityId: null, lastDate: "2026-07-01", activeMonths: 5 }], returned: [], churned: [] },
          regular: [{ ...ref, payments: 6, intervalDays: 30, cv: 0.1, average: 300, yearlyCost: 3650, lastDate: "2026-09-01", nextExpected: "2026-10-01" }],
          multiCategory: [{ ...ref, categories: [{ categoryId: 1, name: "Home", rows: 6, share: 0.6 }, { categoryId: 2, name: "Garden", rows: 4, share: 0.4 }], hint: "Split across 2 categories" }],
          businessPersonal: [{ ...ref, business: 3, personal: 7, businessShare: 0.3 }],
          people: [{ id: "e:5", name: "Степаненко", entityId: 5, paid: 4000, received: 500, net: -3500, byPurpose: [{ purpose: "компенсація житла", paid: 4000, received: 0, rows: 2 }] }],
        }),
      };
    }
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
    await screen.findByLabelText("Summary");
    open(/^Directory/, /^All spellings/);
    expect(screen.getAllByText("3 spellings").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Needs your decision").length).toBeGreaterThan(0);
  });

  it("shows clusters with confidence and reasons", async () => {
    setup();
    await screen.findByLabelText("Summary");
    open(/^Queue/);
    expect(screen.getByRole("tab", { name: /Similar spellings/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByTitle("How sure the match is")[0].textContent).toBe("90%");
    expect(screen.getByText(/one-letter suffix/)).toBeTruthy();
    expect(screen.getByText("Looks like a private person")).toBeTruthy();
  });

  it("filters by search across spellings", async () => {
    setup();
    await screen.findByLabelText("Summary");
    open(/^Directory/, /^All spellings/);
    fireEvent.change(screen.getByPlaceholderText("Search merchants…"), { target: { value: "derkach" } });
    expect(screen.queryAllByText("Епіцентр К")).toHaveLength(0);
    expect(screen.getAllByText("Деркач Олександр Петрович").length).toBeGreaterThan(0);
  });

  it("merges a cluster after a preview of the rows it renames", async () => {
    const calls = setup();
    await screen.findByLabelText("Summary");
    open(/^Queue/);
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
    await screen.findByLabelText("Summary");
    open(/^Changes/);
    expect(screen.getByText(/Merged · 12 rows · by AI \(MCP\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("shows insights: concentration, monthly spend and regular counterparties", async () => {
    setup();
    // Insights are on the Overview, where the section opens.
    expect(await screen.findByText("91%")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Spend per month/ })).toBeTruthy();
    expect(screen.getByText(/monthly · ~30 days/)).toBeTruthy();
    // P5d merchant analyses
    expect(await screen.findByText("1. Receipt (payment size)")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Histogram of payment sizes for Епіцентр/ })).toBeTruthy();
    expect(screen.getByText(/more \/ fewer payments/).textContent).toMatch(/600/);
    expect(screen.getByText(/3[\s,.]?650.*a year/)).toBeTruthy();
    expect(screen.getByText("Netflix")).toBeTruthy();
    expect(screen.getByText("компенсація житла")).toBeTruthy();
    expect(screen.getByText(/Home 60% · Garden 40%/)).toBeTruthy();
  });

  it("P8: opens on the Overview with the summary strip; the queue opens on Similar spellings; settings behind the gear", async () => {
    setup();
    const strip = await screen.findByLabelText("Summary");
    expect(screen.getByRole("tab", { name: /^Overview/ }).getAttribute("aria-selected")).toBe("true");
    expect(strip.textContent).toMatch(/Merchants3/);
    expect(strip.textContent).toMatch(/Not in directory3/);
    expect(strip.textContent).toMatch(/Merge candidates2/);
    expect(strip.textContent).toMatch(/Auto-replaceOFF/);
    expect(screen.getByRole("link", { name: /Review with AI/ }).getAttribute("href")).toBe("/merchants/review");
    // The queue tab carries the number of decisions waiting (2 clusters).
    expect(screen.getByRole("tab", { name: /^Queue/ }).textContent).toMatch(/Queue2/);
    fireEvent.click(screen.getByRole("button", { name: /Merge candidates/ }));
    expect(screen.getByRole("tab", { name: /Similar spellings/ }).getAttribute("aria-selected")).toBe("true");
    expect(navigationCalls.at(-1)).toBe("/merchants?tab=queue&view=clusters");
    expect(screen.queryByText("Auto-replace known spellings on import")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Studio settings" }));
    expect(await screen.findByText("Auto-replace known spellings on import")).toBeTruthy();
    expect(screen.getByText("Auto-merge close new spellings")).toBeTruthy();
    expect(screen.getByText(/Merchants → Dictionaries & packs/)).toBeTruthy();
  });

  it("P8: type words and the dictionary file live on Dictionaries & packs", async () => {
    setup();
    await screen.findByLabelText("Summary");
    open(/^Dictionaries/);
    expect(screen.getByText("Dictionary file")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit merchant types" })).toBeTruthy();
  });

  it("P8: the section, view and search come back from the URL", async () => {
    resetNavigation({ search: "tab=directory&view=spellings&q=derkach" });
    setup();
    await screen.findByLabelText("Search merchants…");
    expect(screen.getByRole("tab", { name: /^All spellings/ }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("Search merchants…") as HTMLInputElement).value).toBe("derkach");
    expect(screen.queryAllByText("Епіцентр К")).toHaveLength(0);
  });

  it("P5a: a payee outside the directory opens a side panel with Add to directory / Show transactions", async () => {
    setup();
    await screen.findByLabelText("Summary");
    open(/^Queue/, /^Unrecognized/);
    fireEvent.click(screen.getAllByRole("button", { name: "Епіцентр К" })[0]);
    expect(await screen.findByText("Top categories")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show transactions" }).getAttribute("href")).toContain("search=");
    fireEvent.click(screen.getByRole("button", { name: "Add to directory" }));
    expect(await screen.findByText(/Renames 12 rows/)).toBeTruthy();
  });

  it("P5a: Explain asks the server why two payees are (not) clustered", async () => {
    const calls = setup();
    await screen.findByLabelText("Summary");
    open(/^Queue/);
    fireEvent.click(screen.getByRole("button", { name: "Explain…" }));
    fireEvent.change(screen.getByLabelText("First payee"), { target: { value: "Rozetka" } });
    fireEvent.change(screen.getByLabelText("Second payee"), { target: { value: "Comfy" } });
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    expect(await screen.findByText("Kept apart")).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith("/api/payees/explain?a=Rozetka&b=Comfy"))).toBe(true);
  });
});

describe("Settings → Payees paging", () => {
  it("pages long lists by 25 / 50", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...base, key: `p${i}`, name: `Payee ${String(i).padStart(2, "0")}`, suggestedName: `Payee ${i}`, count: 100 - i, rows: 100 - i, total: -1,
      spellings: [{ spelling: `Payee ${String(i).padStart(2, "0")}`, count: 1 }], type: { type: "other", confidence: 0.2, isPerson: false, reason: "" },
    }));
    resetNavigation({ search: "tab=queue" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ groups: many, totalGroups: 60, clusters: [], currency: "UAH", truncated: [], undecryptable: 0, entities: [], batches: [], settings: { advancedMode: false, identifierKinds: [], importHint: true }, language: "en" }),
    })));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PayeesSettingsPage />
      </SWRConfig>,
    );
    // No clusters → the queue opens on Unrecognized.
    expect((await screen.findAllByText("Payee 00")).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: /^Unrecognized/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryAllByText("Payee 30")).toHaveLength(0);
    expect(screen.getByText("1–25 of 60")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getAllByText("Payee 30").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "50" } });
    expect(screen.getByText("1–50 of 60")).toBeTruthy();
  });
});

describe("Settings → Payees look-alikes (P5b)", () => {
  it("offers the three answers, moves the rest to a tag after a preview, remembers «different payee»", async () => {
    const calls = setup();
    await screen.findByLabelText("Summary");
    open(/^Queue/, /^Other spellings/);
    expect(await screen.findByText("Степаненко компенсація житла")).toBeTruthy();
    expect(screen.getAllByText("Needs your decision").length).toBeGreaterThan(0);
    expect(screen.getByText("Belongs to an entry, not renamed yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    const keep = screen.getByLabelText("Text to keep from Степаненко компенсація житла") as HTMLInputElement;
    expect(keep.value).toBe("компенсація житла");
    fireEvent.click(screen.getByRole("button", { name: "Same payee, keep the rest" }));
    await screen.findByText(/Renames 12 rows/);
    const dry = calls.find((c) => c.body?.op === "move_remainder")!;
    expect(dry.body).toMatchObject({ entityId: 5, remainder: "компенсація житла", target: "tag", payees: ["Степаненко компенсація житла"], dryRun: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Different payee" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/payees/lookalikes" && c.body?.action === "reject" && c.body?.entityId === 5)).toBe(true));
    expect(screen.getByText(/Answered “Different payee” \(1\)/)).toBeTruthy();
  });
});

describe("Settings → Payees requisites tab (P5f)", () => {
  it("looks for requisites only when asked and saves picked ones as drafts", async () => {
    const calls = setup();
    await screen.findByLabelText("Summary");
    open(/^Channels/);
    expect(calls.some((c) => c.url.includes("action=mine"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Look for requisites in my transactions" }));
    expect(await screen.findByText("•••• 5678")).toBeTruthy();
    expect(screen.getByText("weak evidence")).toBeTruthy();
    expect(screen.getByText(/via iban UA21…6001/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Pick Card •••• 5678"));
    fireEvent.click(screen.getByRole("button", { name: "Save 1 as drafts for review" }));
    expect(await screen.findByText(/Saved 1 draft/)).toBeTruthy();
    expect(calls.find((c) => c.url === "/api/payees/requisites" && c.body)?.body).toEqual({ action: "propose", refs: ["r_card000000000000"] });
  });
});

describe("Settings → Payees find by card (P5g)", () => {
  it("lists every candidate for 4 digits with hints and offers Add to payee for one that lacks it", async () => {
    const calls = setup();
    await screen.findByLabelText("Summary");
    open(/^Channels/);
    fireEvent.change(screen.getByLabelText("Card, IBAN or tax id"), { target: { value: "5168 **** 1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText(/belong to 2 payees/)).toBeTruthy();
    expect(screen.getByText(/the last 4 digits of a card only hint/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show transactions" }).getAttribute("href")).toBe("/transactions?identifier=5168+****+1234");
    expect(screen.queryByRole("button", { name: "Add to payee Степаненко" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add to payee Коваль Петро" }));
    await waitFor(() => expect(calls.some((c) => c.body?.op === "identifiers" && JSON.stringify(c.body.add) === JSON.stringify([{ kind: "card_last4", value: "1234" }]))).toBe(true));
  });
});


describe("Merchants directory chips and filters (P8)", () => {
  const entity = (id: number, name: string, type: string, extra: Record<string, unknown> = {}) => ({
    id, name, type, aliasCount: 1, aliasNames: [], identifierCount: 0, defaultCategoryId: null, merchantType: null, merchantTypeHint: null, merchantTypeMixed: null, count: 1, total: -1, lastDate: null, ...extra,
  });
  it("splits entries into merchants / people / channels and filters untyped, without requisites, needing a check", async () => {
    resetNavigation({ search: "tab=directory" });
    const entities = [
      entity(1, "Сільпо", "retail", { merchantType: { id: 1, group: "Супермаркети і продукти", name: "Супермаркети і продукти", code: "grocery" }, identifierCount: 1 }),
      entity(2, "Степаненко", "person"),
      entity(3, "Комісія банку", "bank", { merchantType: { id: 2, group: "Банківські операції", name: "Комісії банку", code: "bank_fees" } }),
      entity(4, "Ma", "other"),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ groups: [], totalGroups: 0, clusters: [], currency: "UAH", truncated: [], undecryptable: 0, entities, batches: [], settings: { advancedMode: false, identifierKinds: [] }, suspicious: [{ id: 4, name: "Ma", reasons: [], count: 1, spellings: [] }] }),
    })));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PayeesSettingsPage />
      </SWRConfig>,
    );
    expect(await screen.findByRole("button", { name: "All · 4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merchants · 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "People · 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Channels · 1" }));
    expect(screen.getByText("Комісія банку")).toBeTruthy();
    expect(screen.queryByText("Сільпо")).toBeNull();
    expect(navigationCalls.at(-1)).toBe("/merchants?tab=directory&chip=channels");
    fireEvent.click(screen.getByRole("button", { name: "All · 4" }));
    fireEvent.click(screen.getByLabelText("needs a check"));
    expect(screen.getByRole("link", { name: "Ma" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Степаненко" })).toBeNull();
    fireEvent.click(screen.getByLabelText("needs a check"));
    fireEvent.click(screen.getByLabelText("no requisites"));
    expect(screen.queryByRole("link", { name: "Сільпо" })).toBeNull();
    fireEvent.click(screen.getByLabelText("no type"));
    expect(screen.queryByRole("link", { name: "Комісія банку" })).toBeNull();
    expect(screen.getByRole("link", { name: "Степаненко" })).toBeTruthy();
  });

  it("an empty list says why and offers a way out", async () => {
    resetNavigation({ search: "tab=directory&chip=people" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ groups: [], totalGroups: 0, clusters: [], currency: "UAH", truncated: [], undecryptable: 0, entities: [entity(1, "Сільпо", "retail")], batches: [], settings: { advancedMode: false, identifierKinds: [] } }),
    })));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PayeesSettingsPage />
      </SWRConfig>,
    );
    expect(await screen.findByText("No entry matches these chips and filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("link", { name: "Сільпо" })).toBeTruthy();
  });

  it("a load error offers Try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "x" }) })));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <PayeesSettingsPage />
      </SWRConfig>,
    );
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
