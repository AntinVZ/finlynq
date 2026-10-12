/**
 * @vitest-environment jsdom
 *
 * "Counterparty requisites found" (P5g, reverse direction): masked requisites
 * from a transaction's payee / note, "Add to payee" for the resolved entry.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CounterpartyRequisites } from "@/components/payees/counterparty-requisites";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CounterpartyRequisites", () => {
  it("shows masked requisites and adds one to the payee's directory entry", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      if (url.startsWith("/api/payees/requisites?action=resolve")) return { ok: true, json: async () => ({ entity: { id: 5, name: "Степаненко", type: "person" } }) };
      return { ok: true, json: async () => ({ op: "identifiers", batchId: null, entity: null, created: false, aliasesAdded: [], aliasesRemoved: 0, identifiersAdded: [{ kind: "card_last4", masked: "•••• 5678" }], identifiersRemoved: 0, entitiesRemoved: 0, rows: { total: 0, byTable: { transactions: 0, recurring: 0, staged: 0 }, changes: [], conflicts: [], truncated: false }, warnings: [], blocked: null }) };
    }));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CounterpartyRequisites payee="Степаненко" note="з картки 4149 4999 1234 5678, ІПН 3123456789" />
      </SWRConfig>,
    );
    expect(screen.getByText("Counterparty requisites found")).toBeTruthy();
    expect(screen.getByText("•••• 5678")).toBeTruthy();
    expect(screen.getByText("••••••••89")).toBeTruthy();
    expect(document.body.textContent).not.toContain("4149 4999");
    const add = await screen.findAllByRole("button", { name: "Add to payee Степаненко" });
    fireEvent.click(add[1]);
    await waitFor(() => expect(calls.some((c) => c.body?.op === "identifiers" && JSON.stringify(c.body.add) === JSON.stringify([{ kind: "card_last4", value: "5678" }]))).toBe(true));
  });

  it("renders nothing when the text has no requisites", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { container } = render(<CounterpartyRequisites payee="Сільпо" note="продукти 12345678" />);
    expect(container.textContent).toBe("");
  });
});
