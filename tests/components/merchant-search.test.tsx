/**
 * @vitest-environment jsdom
 *
 * The global Merchants search (P8 stage 1): Ctrl/Cmd+K opens it, a requisite
 * finds the entry and offers "whose is it" (the requisite travels in
 * sessionStorage, never in the URL), a full card number is refused before
 * anything is sent, a failed search offers Try again.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/navigation", async () => (await import("../helpers/next-navigation")).navigationMock);

import { MerchantSearch, WHOSE_PENDING_KEY } from "@/components/merchants/merchant-search";
import { navigationCalls, resetNavigation } from "../helpers/next-navigation";

function setup(result: unknown, ok = true) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url === "/api/settings/locale") return { ok: true, json: async () => ({ language: "en", preference: { language: "auto" } }) };
    return { ok, status: ok ? 200 : 500, json: async () => result };
  }));
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MerchantSearch />
    </SWRConfig>,
  );
  return calls;
}

beforeEach(() => {
  resetNavigation({ pathname: "/dashboard" });
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Merchants search (Ctrl/Cmd+K)", () => {
  it("opens on Ctrl+K, finds an entry by IBAN and hands “whose is it” over without the URL", async () => {
    const calls = setup({
      hits: [{ kind: "requisite", label: "Степаненко", entityId: 5, entityName: "Степаненко", type: "person", detail: "UA21…6001" }],
      requisite: { kind: "iban", masked: "UA21…6001", strength: "strong" }, own: null, refusal: null,
    });
    act(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    const box = await screen.findByRole("combobox");
    fireEvent.change(box, { target: { value: "UA213223130000026007233566001" } });
    expect(await screen.findByText("Степаненко")).toBeTruthy();
    expect(screen.getByText("requisite UA21…6001")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/payees/search?q=UA21"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /Whose is UA21…6001/ }));
    expect(window.sessionStorage.getItem(WHOSE_PENDING_KEY)).toBe("UA213223130000026007233566001");
    expect(navigationCalls.at(-1)).toBe("/merchants?tab=channels");
  });

  it("opens the entry with Enter", async () => {
    setup({ hits: [{ kind: "entity", label: "Епіцентр", entityId: 1, entityName: "Епіцентр", type: "retail", detail: null }], requisite: null, own: null, refusal: null });
    act(() => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    const box = await screen.findByRole("combobox");
    fireEvent.change(box, { target: { value: "епі" } });
    await screen.findByText("Епіцентр");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(navigationCalls.at(-1)).toBe("/merchants/1");
  });

  it("refuses a full card number before sending it", async () => {
    const calls = setup({ hits: [], requisite: null, own: null, refusal: null });
    act(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "5168 7573 1234 5678" } });
    expect(screen.getByText(/A full card number is never searched/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.some((c) => c.startsWith("/api/payees/search"))).toBe(false);
  });

  it("offers Try again when the search fails", async () => {
    setup({ error: "x" }, false);
    act(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "rozetka" } });
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
