/**
 * @vitest-environment jsdom
 *
 * Settings → Payees → AI review (P3): drafts with reason / confidence,
 * "Select ≥ threshold" skips people, accept previews through
 * /api/payees/proposals before committing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import PayeeReviewPage from "@/app/(app)/settings/payees/review/page";

const proposals = [
  { id: 1, canonical: "Епіцентр", type: "retail", entityId: null, aliases: [{ pattern: "Epicentr", mode: "exact" }], identifiers: [], reason: "Same chain", confidence: 0.95, needsDecision: false, notes: [], status: "draft", createdAt: "" },
  { id: 2, canonical: "Деркач Олександр Петрович", type: "person", entityId: null, aliases: [], identifiers: [], reason: "Same person", confidence: 0.97, needsDecision: true, notes: [], status: "draft", createdAt: "" },
  { id: 3, canonical: "Bulochka", type: "retail", entityId: null, aliases: [], identifiers: [], reason: "Bakery", confidence: 0.6, needsDecision: false, notes: [], status: "draft", createdAt: "" },
];

function setup() {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url === "/api/payees/proposals" && !body) return { ok: true, json: async () => ({ proposals }) };
    if (body?.action === "approve") {
      return {
        ok: true,
        json: async () => ({
          op: "bulk", batchId: 9, entity: null, created: true, aliasesAdded: [], aliasesRemoved: 0, identifiersAdded: [], identifiersRemoved: 0, entitiesRemoved: 0,
          rows: { total: 5, byTable: { transactions: 5, recurring: 0, staged: 0 }, changes: [{ from: "Epicentr", to: "Епіцентр", count: 5 }], conflicts: [], truncated: false },
          warnings: [], blocked: null, approved: body.ids,
        }),
      };
    }
    return { ok: true, json: async () => ({ rejected: 1 }) };
  }));
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PayeeReviewPage />
    </SWRConfig>,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings → Payees → AI review", () => {
  it("selects only confident non-person drafts and previews before accepting", async () => {
    const calls = setup();
    expect(await screen.findByText("Same chain")).toBeTruthy();
    expect(screen.getByText("Needs decision")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Select ≥ 90% \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: /Accept selected \(1\)/ }));
    expect(await screen.findByText(/Renames 5 rows: 5 in transactions/)).toBeTruthy();
    expect(calls.find((c) => c.body?.dryRun === true)!.body).toEqual({ action: "approve", ids: [1], dryRun: true });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(calls.some((c) => c.body?.action === "approve" && c.body.dryRun === undefined)).toBe(true));
  });

  it("rejects a draft", async () => {
    const calls = setup();
    await screen.findByText("Bakery");
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[2]);
    await waitFor(() => expect(calls.some((c) => c.body?.action === "reject")).toBe(true));
    expect(calls.find((c) => c.body?.action === "reject")!.body).toEqual({ action: "reject", ids: [3] });
  });
});
