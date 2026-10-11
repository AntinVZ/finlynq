/**
 * @vitest-environment jsdom
 *
 * Reports / Transactions: the page starts on the global scope; picking another
 * value shows "Scope changed on this page" with a reset button, nothing is
 * saved to the server, and "Reset to global" returns to the global scope.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ViewScopeProvider } from "@/components/view-scope-provider";
import { usePageScope, PageScopeControl } from "@/components/page-scope";

function mockSettings(usageMode: string, viewScope: string) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => (url.includes("usage-mode") ? { usageMode } : { viewScope }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Page() {
  const ps = usePageScope();
  return (
    <>
      <PageScopeControl {...ps} />
      <span data-testid="applied">{ps.scope}</span>
    </>
  );
}

const renderPage = () => render(<ViewScopeProvider><Page /></ViewScopeProvider>);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PageScopeControl", () => {
  it("personal usage mode: no control, scope all", async () => {
    const f = mockSettings("personal", "business");
    renderPage();
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByTestId("applied").textContent).toBe("all");
  });

  it("follows global, overrides locally without saving, resets", async () => {
    const f = mockSettings("business_too", "business");
    renderPage();
    await waitFor(() => expect(screen.getByTestId("applied").textContent).toBe("business"));
    expect(screen.queryByTestId("page-scope-override")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Personal" }));
    expect(screen.getByTestId("applied").textContent).toBe("personal");
    expect(screen.getByText("Scope changed on this page")).toBeTruthy();
    expect(f.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Reset to global/ }));
    expect(screen.getByTestId("applied").textContent).toBe("business");
    expect(screen.queryByTestId("page-scope-override")).toBeNull();
  });
});
