/**
 * @vitest-environment jsdom
 *
 * «Готово · Скасувати» (P8 stage 3): the toast goes away after 10 seconds;
 * "Undo" runs the undo op on that batch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useUndoToast, UNDO_TOAST_MS } from "@/components/merchants/undo-toast";

function Host({ onUndone }: { onUndone: (n: number) => void }) {
  const toast = useUndoToast(onUndone);
  return (
    <>
      <button type="button" onClick={() => toast.show(7, "Renames 3 rows")}>go</button>
      {toast.node}
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = (onUndone = vi.fn()) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Host onUndone={onUndone} />
    </SWRConfig>,
  );

describe("undo toast", () => {
  it("disappears after 10 seconds", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ language: "en" }) })));
    mount();
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("Undo")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS - 100);
    });
    expect(screen.getByText("Undo")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Undo")).toBeNull();
  });

  it("Undo posts op undo for the batch", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
      if (init?.body) calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ undo: { restoredRows: 3 } }) };
    }));
    const onUndone = vi.fn();
    mount(onUndone);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(onUndone).toHaveBeenCalledWith(3));
    expect(calls).toEqual([{ op: "undo", batchId: 7 }]);
  });
});
