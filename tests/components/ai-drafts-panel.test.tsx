/**
 * @vitest-environment jsdom
 *
 * AI drafts (P8 stage 9): a draft from MCP carries «Proposed by Claude»,
 * confident exceptions (a person, a warning) are counted and not selected
 * by "Select ≥ threshold", and «Copy prompt for Claude» puts a recipe on
 * the clipboard.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/navigation", async () => (await import("../helpers/next-navigation")).navigationMock);

import { AiDraftsPanel } from "@/app/(app)/merchants/_components/ai-drafts-panel";

const draft = (id: number, over: Record<string, unknown>) => ({
  id, canonical: `Draft ${id}`, type: "merchant", entityId: null, aliases: [], identifiers: [], reason: "", confidence: 0.95,
  needsDecision: false, notes: [], status: "draft", source: "mcp", createdAt: "2026-10-14", ...over,
});

function setup() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/settings/locale") return { ok: true, json: async () => ({ language: "en", preference: { language: "auto" } }) };
    return { ok: true, status: 200, json: async () => ({ proposals: [draft(1, {}), draft(2, { needsDecision: true }), draft(3, { source: "web", confidence: 0.5 })] }) };
  }));
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AiDraftsPanel />
    </SWRConfig>,
  );
  return { writeText };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI drafts panel", () => {
  it("badges drafts from Claude, counts exceptions, selects only eligible ones", async () => {
    setup();
    expect(await screen.findByText("Draft 1")).toBeTruthy();
    expect(screen.getAllByTestId("claude-badge")).toHaveLength(2);
    expect(screen.getByText(/1 confident draft is an exception/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Select ≥ 90%/ }));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
  });

  it("copies the prompt for Claude", async () => {
    const { writeText } = setup();
    fireEvent.click(await screen.findByTestId("copy-claude-prompt"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String((writeText.mock.calls[0] as unknown[])[0])).toMatch(/manage_payees op=review/);
  });
});
