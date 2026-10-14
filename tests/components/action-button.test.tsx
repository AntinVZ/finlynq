/**
 * @vitest-environment jsdom
 *
 * P8 stage 5: ActionButton (intent = colour + icon + label, danger summary),
 * keyboard decisions on a list (J/K, Enter, Backspace, ?, off switch).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ActionButton } from "@/components/actions/action-button";
import { useListKeyboard, useShortcutsEnabled } from "@/components/actions/use-list-keyboard";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ActionButton", () => {
  it("always has a label and the intent's icon; icon-only keeps the label as its name", () => {
    render(
      <>
        <ActionButton intent="confirm">Make canonical</ActionButton>
        <ActionButton intent="reject" iconOnly>
          Reject
        </ActionButton>
      </>,
    );
    const confirm = screen.getByRole("button", { name: "Make canonical" });
    expect(confirm.dataset.intent).toBe("confirm");
    expect(confirm.querySelector("svg")).not.toBeNull();
    expect(confirm.className).toMatch(/bg-action-confirm/);
    expect(confirm.className).toMatch(/pointer-coarse:min-h-11/);
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject.getAttribute("title")).toBe("Reject");
  });

  it("links a danger action to its summary of what will change", () => {
    render(
      <ActionButton intent="reject" summary="Renames 12 rows">
        Delete
      </ActionButton>,
    );
    const b = screen.getByRole("button", { name: "Delete" });
    const id = b.getAttribute("aria-describedby");
    expect(id && document.getElementById(id)?.textContent).toBe("Renames 12 rows");
  });
});

function List({ onConfirm, onReject }: { onConfirm: (x: string) => void; onReject: (x: string) => void }) {
  const kb = useListKeyboard({ items: ["a", "b", "c"], onConfirm, onReject });
  const [, setOn] = useShortcutsEnabled();
  return (
    <div>
      <output data-testid="index">{kb.index}</output>
      <output data-testid="help">{String(kb.helpOpen)}</output>
      <button type="button" onClick={() => setOn(false)}>
        off
      </button>
      <input aria-label="field" />
    </div>
  );
}

describe("useListKeyboard", () => {
  it("moves with J/K, confirms with Enter, rejects with Backspace, opens help with ?", () => {
    const onConfirm = vi.fn();
    const onReject = vi.fn();
    render(<List onConfirm={onConfirm} onReject={onReject} />);
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    expect(screen.getByTestId("index").textContent).toBe("1");
    act(() => void fireEvent.keyDown(window, { key: "k" }));
    act(() => void fireEvent.keyDown(window, { key: "Enter" }));
    expect(onConfirm).toHaveBeenCalledWith("a");
    act(() => void fireEvent.keyDown(window, { key: "Backspace" }));
    expect(onReject).toHaveBeenCalledWith("a");
    act(() => void fireEvent.keyDown(window, { key: "?" }));
    expect(screen.getByTestId("help").textContent).toBe("true");
  });

  it("ignores keys typed in a field, and everything once switched off", () => {
    const onConfirm = vi.fn();
    render(<List onConfirm={onConfirm} onReject={vi.fn()} />);
    act(() => void fireEvent.keyDown(screen.getByLabelText("field"), { key: "j" }));
    expect(screen.getByTestId("index").textContent).toBe("-1");
    fireEvent.click(screen.getByRole("button", { name: "off" }));
    act(() => void fireEvent.keyDown(window, { key: "j" }));
    act(() => void fireEvent.keyDown(window, { key: "Enter" }));
    expect(screen.getByTestId("index").textContent).toBe("-1");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("finlynq.shortcuts.off")).toBe("1");
  });
});
