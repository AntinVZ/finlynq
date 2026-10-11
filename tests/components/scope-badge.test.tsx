/**
 * @vitest-environment jsdom
 *
 * Home page scope labels: flow widgets show the current scope; balance widgets
 * show "All accounts" (with the reason) only while the scope is not All; in
 * personal usage mode neither appears.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ViewScopeProvider } from "@/components/view-scope-provider";
import { AllAccountsBadge, ScopeBadge, ALL_ACCOUNTS_HINT } from "@/components/scope-badge";

function mockSettings(usageMode: string, viewScope: string) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.includes("usage-mode") ? { usageMode } : { viewScope }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderBadges() {
  return render(
    <ViewScopeProvider>
      <ScopeBadge />
      <AllAccountsBadge />
    </ViewScopeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("scope badges", () => {
  it("personal usage mode: no badges at all", async () => {
    const f = mockSettings("personal", "business");
    renderBadges();
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("scope-badge")).toBeNull();
    expect(screen.queryByTestId("all-accounts-badge")).toBeNull();
  });

  it("business scope: flow badge says Business, balance badge explains why", async () => {
    mockSettings("business_too", "business");
    renderBadges();
    await waitFor(() => expect(screen.getByTestId("scope-badge").textContent).toBe("Business"));
    const all = screen.getByTestId("all-accounts-badge");
    expect(all.textContent).toBe("All accounts");
    expect(all.getAttribute("title")).toBe(ALL_ACCOUNTS_HINT);
  });

  it("All scope: flow badge says All, no All-accounts badge", async () => {
    mockSettings("business_too", "all");
    renderBadges();
    await waitFor(() => expect(screen.getByTestId("scope-badge").textContent).toBe("All"));
    expect(screen.queryByTestId("all-accounts-badge")).toBeNull();
  });
});
