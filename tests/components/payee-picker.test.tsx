/**
 * @vitest-environment jsdom
 *
 * PayeePicker (P8 stage 4): free text is an explicit choice — «Add to the
 * directory» / «Text only»; «Require a payee from the directory» hides the
 * second and warns; «Recommended: X» offers the canonical name; an import
 * list gets one chip per row from one request.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useState } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { PayeePicker, type PayeeFieldState } from "@/components/payees/payee-picker";
import { RecommendedChip, usePayeeRecommendations } from "@/components/payees/recommended-chip";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Handler = (url: string, body: Record<string, unknown> | null) => unknown;

function stub(handler: Handler) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const out = handler(url, body);
    return { ok: out !== undefined, status: out === undefined ? 404 : 200, json: async () => out ?? {} };
  }));
  return calls;
}

function Harness({ onState }: { onState?: (s: PayeeFieldState) => void }) {
  const [v, setV] = useState("");
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PayeePicker value={v} onChange={setV} onStateChange={onState} />
      <output data-testid="value">{v}</output>
    </SWRConfig>
  );
}

const SUGGEST = { suggestions: [{ value: "Сільпо", label: "Сільпо", kind: "entity", entityId: 2, entityName: "Сільпо", type: "retail" }] };

describe("PayeePicker", () => {
  it("ends the list with «Add to the directory» and «Text only» for a new name; adding creates the entry", async () => {
    const calls = stub((url, body) => {
      if (url === "/api/payees/settings") return { requireDirectoryPayee: false };
      if (url.startsWith("/api/payees/suggest")) return SUGGEST;
      if (url.startsWith("/api/payees/resolve")) return { kind: "none" };
      if (url === "/api/payees" && body?.op === "create") return { entity: { id: 9, name: "Нова кав'ярня", type: "retail" }, batchId: 5 };
      return undefined;
    });
    const states: PayeeFieldState[] = [];
    render(<Harness onState={(s) => states.push(s)} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "Нова кав'ярня" } });
    expect(await screen.findByText("Add “Нова кав'ярня” to the directory")).toBeTruthy();
    expect(screen.getByText("Text only")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("Add “Нова кав'ярня” to the directory"));
    expect(await screen.findByText("Added to the directory: Нова кав'ярня")).toBeTruthy();
    expect(calls.find((c) => c.body?.op === "create")?.body).toEqual({ op: "create", name: "Нова кав'ярня", apply: false });
    await waitFor(() => expect(states.at(-1)).toMatchObject({ value: "Нова кав'ярня", entityId: 9, fromDirectory: true }));
  });

  it("«Text only» keeps free text and says so", async () => {
    stub((url) => {
      if (url === "/api/payees/settings") return {};
      if (url.startsWith("/api/payees/suggest")) return { suggestions: [] };
      if (url.startsWith("/api/payees/resolve")) return { kind: "none" };
      return undefined;
    });
    const states: PayeeFieldState[] = [];
    render(<Harness onState={(s) => states.push(s)} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "Бабуся" } });
    fireEvent.mouseDown(await screen.findByText("Text only"));
    await waitFor(() => expect(states.at(-1)).toMatchObject({ value: "Бабуся", fromDirectory: false, freeText: true }));
    expect(screen.queryByText("Text only")).toBeNull();
  });

  it("with «Require a payee from the directory» offers only Add and warns", async () => {
    stub((url) => {
      if (url === "/api/payees/settings") return { requireDirectoryPayee: true };
      if (url.startsWith("/api/payees/suggest")) return { suggestions: [] };
      if (url.startsWith("/api/payees/resolve")) return { kind: "none" };
      return undefined;
    });
    const states: PayeeFieldState[] = [];
    render(<Harness onState={(s) => states.push(s)} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "Бабуся" } });
    expect(await screen.findByText("Add “Бабуся” to the directory")).toBeTruthy();
    expect(screen.queryByText("Text only")).toBeNull();
    expect(await screen.findByText(/Pick a payee from the directory or add this one/)).toBeTruthy();
    await waitFor(() => expect(states.at(-1)).toMatchObject({ required: true, fromDirectory: false }));
  });

  it("«Recommended: X» offers the canonical name of a known spelling", async () => {
    stub((url) => {
      if (url === "/api/payees/settings") return {};
      if (url.startsWith("/api/payees/suggest")) return { suggestions: [] };
      if (url.startsWith("/api/payees/resolve")) return { kind: "match", entityId: 1, name: "Епіцентр", via: "exact", same: false };
      return undefined;
    });
    const states: PayeeFieldState[] = [];
    render(<Harness onState={(s) => states.push(s)} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "EPITCENTR K10" } });
    fireEvent.click(await screen.findByRole("button", { name: /Recommended: Епіцентр/ }));
    expect(screen.getByTestId("value").textContent).toBe("Епіцентр");
    await waitFor(() => expect(states.at(-1)).toMatchObject({ entityId: 1, fromDirectory: true }));
  });

  it("an import list asks once for every row and shows a chip where a payee resolves elsewhere", async () => {
    const calls = stub((url, body) => {
      if (url === "/api/payees/resolve" && body) return { results: { "EPITCENTR K10": { kind: "match", entityId: 1, name: "Епіцентр", via: "exact", same: false }, "Сільпо": { kind: "match", entityId: 2, name: "Сільпо", via: "exact", same: true } } };
      return {};
    });
    const applied: string[] = [];
    function List() {
      const rec = usePayeeRecommendations(["EPITCENTR K10", "Сільпо", "Бабуся"]);
      return (
        <ul>
          {["EPITCENTR K10", "Сільпо", "Бабуся"].map((p) => (
            <li key={p}>
              {p}
              <RecommendedChip rec={rec(p)} onApply={(n) => applied.push(n)} />
            </li>
          ))}
        </ul>
      );
    }
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <List />
      </SWRConfig>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Recommended: Епіцентр/ }));
    expect(applied).toEqual(["Епіцентр"]);
    expect(screen.getAllByRole("button", { name: /Recommended/ })).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/payees/resolve")).toHaveLength(1);
    expect(calls.find((c) => c.url === "/api/payees/resolve")?.body).toEqual({ payees: ["Бабуся", "EPITCENTR K10", "Сільпо"].sort() });
  });
});
