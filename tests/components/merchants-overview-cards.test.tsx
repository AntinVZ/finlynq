/**
 * @vitest-environment jsdom
 *
 * The Merchants overview (P8 stage 2): coverage with a bar, the 30 days /
 * 90 days / year switch refetches, the one-time «What's here» hint is
 * remembered, «Start» steps open their places; and the Transactions chip
 * text «56 · 38K ₴».
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/navigation", async () => (await import("../helpers/next-navigation")).navigationMock);

import { MerchantsOverviewCards, INTRO_SEEN_KEY } from "@/app/(app)/merchants/_components/overview-cards";
import { merchantSummaryText } from "@/app/(app)/transactions/_components/merchant-filters";

const CARDS = {
  period: "90d", from: "2026-07-15", to: "2026-10-12", currency: "UAH",
  coverage: { rows: 10, covered: 7, pct: 70, spend: 1000, coveredSpend: 700 },
  topUncovered: [{ name: "ZZ NEW SHOP", count: 2, spend: 300 }],
  newMerchants: [], largeChecks: [], duplicates: { count: 0, items: [] }, silent: [], untyped: 3, truncated: false,
};

function setup(start = { hasDirectory: true, typedAll: false, hintOn: false }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url === "/api/settings/locale") return { ok: true, json: async () => ({ language: "en", preference: { language: "auto" } }) };
    return { ok: true, status: 200, json: async () => CARDS };
  }));
  const onOpen = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MerchantsOverviewCards start={start} onOpen={onOpen} />
    </SWRConfig>,
  );
  return { calls, onOpen };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Merchants overview cards", () => {
  it("shows coverage with a bar and the uncovered top; the period switch refetches", async () => {
    const { calls } = setup();
    const bar = await screen.findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("70");
    expect(screen.getByText("ZZ NEW SHOP")).toBeTruthy();
    const group = screen.getByRole("group");
    const buttons = group.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[2]);
    await waitFor(() => expect(calls.some((c) => c === "/api/payees/overview-cards?period=1y")).toBe(true));
  });

  it("the hint shows once and is remembered; Start steps open their places", async () => {
    const { onOpen } = setup();
    const note = await screen.findByRole("note");
    fireEvent.click(note.querySelector("button")!);
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
    expect(screen.queryByRole("note")).toBeNull();
    const start = screen.getByRole("list", { name: /start/i });
    const steps = start.querySelectorAll("button");
    fireEvent.click(steps[1]);
    expect(onOpen).toHaveBeenCalledWith("untyped");
  });

  it("no Start list once every step is done", async () => {
    setup({ hasDirectory: true, typedAll: true, hintOn: true });
    await screen.findByRole("progressbar");
    expect(screen.queryByRole("list", { name: /start/i })).toBeNull();
  });
});

describe("Transactions merchant chip", () => {
  it("count · sum per currency, + when truncated", () => {
    expect(merchantSummaryText({ count: 56, totals: { UAH: -38000 }, truncated: false })).toMatch(/^56 · /);
    expect(merchantSummaryText({ count: 56, totals: { UAH: -38000 }, truncated: false })).toMatch(/38/);
    expect(merchantSummaryText({ count: 3, totals: {}, truncated: true })).toBe("3+");
  });
});
