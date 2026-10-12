/**
 * @vitest-environment jsdom
 *
 * Rule editor (P5e): "Rename payee" suggests directory entries; picking one
 * offers "Also save as alias", which after saving runs the existing
 * alias-from-rule op for that entry (stored payees not renamed).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { RuleEditorDialog } from "@/components/rules/rule-editor-dialog";

vi.mock("@/components/dropdown-order-provider", () => ({ useDropdownOrder: () => (items: unknown[]) => items }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("rule editor — rename payee to a directory entry", () => {
  it("saves the rule, then the rule's payee condition as an alias of the picked entry", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (url.startsWith("/api/payees/suggest")) {
        return { ok: true, json: async () => ({ suggestions: [{ value: "Епіцентр", label: "Епіцентр", kind: "entity", entityId: 7, entityName: "Епіцентр", type: "retail" }] }) };
      }
      return { ok: true, json: async () => ({ batchId: 3 }) };
    }));
    const onSubmit = vi.fn(async () => ({ ok: true as const, ruleId: 42 }));
    const onClose = vi.fn();
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <RuleEditorDialog
          initialName="Epicentr"
          initialConditions={[{ field: "payee", op: "contains", value: "EPITCENTR" } as never]}
          initialActions={[{ kind: "rename_payee", to: "" } as never]}
          categories={[]}
          accounts={[]}
          holdings={[]}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      </SWRConfig>,
    );
    const box = screen.getByRole("combobox", { name: "Clean payee" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "епі" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Епіцентр/ }));
    const check = screen.getByRole("checkbox", { name: /Also save as alias of “Епіцентр”/ });
    fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(onSubmit).toHaveBeenCalled();
    expect(calls.find((c) => c.url === "/api/payees")?.body).toEqual({ op: "alias_from_rule", ruleId: 42, entityId: 7, apply: false });
  });
});
