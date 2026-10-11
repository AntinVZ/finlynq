/**
 * @vitest-environment jsdom
 *
 * Global All / Business / Personal switcher: hidden in personal usage mode,
 * shown in "business too" mode, and a click saves through PUT
 * /api/settings/view-scope (optimistically, rolled back on failure).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { ViewScopeProvider, useViewScope } from "@/components/view-scope-provider";
import { ViewScopeBar } from "@/components/view-scope-switcher";

function mockSettings(usageMode: string, viewScope: string, putOk = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return { ok: putOk, status: putOk ? 200 : 500, json: async () => JSON.parse(String(init.body)) };
    }
    if (url.includes("usage-mode")) return { ok: true, json: async () => ({ usageMode }) };
    return { ok: true, json: async () => ({ viewScope }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ScopeProbe() {
  const { scope } = useViewScope();
  return <span data-testid="scope">{scope}</span>;
}

function renderBar() {
  return render(
    <ViewScopeProvider>
      <ViewScopeBar />
      <ScopeProbe />
    </ViewScopeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ViewScopeBar", () => {
  it("is hidden in personal mode, and the effective scope is all", async () => {
    const fetchMock = mockSettings("personal", "business");
    renderBar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("scope").textContent).toBe("all"));
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("shows the stored scope in business mode and saves a change", async () => {
    const fetchMock = mockSettings("business_too", "business");
    renderBar();
    const business = await screen.findByRole("button", { name: "Business" });
    expect(business.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("scope").textContent).toBe("business");

    fireEvent.click(screen.getByRole("button", { name: "Personal" }));
    await waitFor(() => expect(screen.getByTestId("scope").textContent).toBe("personal"));
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(put?.[0]).toBe("/api/settings/view-scope");
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ viewScope: "personal" });
  });

  it("rolls back when saving fails", async () => {
    mockSettings("business_too", "all", false);
    renderBar();
    fireEvent.click(await screen.findByRole("button", { name: "Business" }));
    await screen.findByText("Couldn't save. Try again.");
    expect(screen.getByTestId("scope").textContent).toBe("all");
  });
});
