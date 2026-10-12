/**
 * @vitest-environment jsdom
 *
 * PayeeCombobox (Payee Studio P5a): free text stays allowed; suggestions come
 * from /api/payees/suggest; picking an alias fills in the canonical name.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useState } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { PayeeCombobox, type PayeeSuggestion } from "@/components/payees/payee-combobox";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ onPick }: { onPick?: (s: PayeeSuggestion) => void }) {
  const [v, setV] = useState("");
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PayeeCombobox value={v} onChange={setV} onPick={onPick} />
      <output data-testid="value">{v}</output>
    </SWRConfig>
  );
}

describe("PayeeCombobox", () => {
  it("suggests directory names, aliases and recent payees; an alias fills in the canonical name", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          suggestions: [
            { value: "Епіцентр", label: "Епіцентр", kind: "entity", entityId: 1, entityName: "Епіцентр", type: "retail" },
            { value: "Епіцентр", label: "EPITCENTR K10 KYIV", kind: "alias", entityId: 1, entityName: "Епіцентр", type: "retail" },
            { value: "Epic Games", label: "Epic Games", kind: "recent", entityId: null, entityName: null, type: null, count: 3 },
          ],
        }),
      };
    }));
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const box = screen.getByRole("combobox", { name: "Payee" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "epi" } });
    expect(await screen.findByText("EPITCENTR K10 KYIV")).toBeTruthy();
    expect(screen.getByText("→ Епіцентр")).toBeTruthy();
    expect(screen.getByText("× 3")).toBeTruthy();
    await waitFor(() => expect(urls.some((u) => u.startsWith("/api/payees/suggest?q=epi"))).toBe(true));
    fireEvent.mouseDown(screen.getByText("EPITCENTR K10 KYIV"));
    expect(screen.getByTestId("value").textContent).toBe("Епіцентр");
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: "alias", entityId: 1 }));
  });

  it("keeps free text and picks with the keyboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ suggestions: [{ value: "Сільпо", label: "Сільпо", kind: "entity", entityId: 2, entityName: "Сільпо", type: "retail" }] }),
    })));
    render(<Harness />);
    const box = screen.getByRole("combobox", { name: "Payee" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "Нова кав'ярня" } });
    expect(screen.getByTestId("value").textContent).toBe("Нова кав'ярня");
    await screen.findByText("Сільпо");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("Сільпо");
  });
});
