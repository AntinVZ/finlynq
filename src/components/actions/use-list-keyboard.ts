"use client";

/**
 * Keyboard decisions for a list of items (P8 stage 5), desktop only:
 *
 *   J / K        next / previous item
 *   Enter        confirm the focused item
 *   Backspace    reject the focused item
 *   O            open the focused item
 *   ?            show the shortcuts
 *
 * Ignored while typing in a field, with a modifier key held, or when the
 * viewer switched shortcuts off (a per-browser preference: `useShortcutsEnabled`).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const STORAGE_KEY = "finlynq.shortcuts.off";
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "1";
  } catch {
    return true;
  }
}

/** Whether keyboard shortcuts are on in this browser, and a setter. */
export function useShortcutsEnabled(): [boolean, (on: boolean) => void] {
  const enabled = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readEnabled,
    () => true,
  );
  const set = useCallback((on: boolean) => {
    try {
      if (on) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
    listeners.forEach((l) => l());
  }, []);
  return [enabled, set];
}

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function useListKeyboard<T>({
  items,
  onConfirm,
  onReject,
  onOpen,
  enabled = true,
}: {
  items: readonly T[];
  onConfirm?: (item: T) => void;
  onReject?: (item: T) => void;
  onOpen?: (item: T) => void;
  enabled?: boolean;
}) {
  const [on] = useShortcutsEnabled();
  const [index, setIndex] = useState(-1);
  const [helpOpen, setHelpOpen] = useState(false);
  const active = enabled && on;
  const current = index >= 0 && index < items.length ? index : -1;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target) || document.querySelector("[role=dialog]")) return;
      const item = current >= 0 ? items[current] : undefined;
      switch (e.key) {
        case "j":
        case "J":
          e.preventDefault();
          setIndex((i) => Math.min(items.length - 1, Math.max(-1, i) + 1));
          break;
        case "k":
        case "K":
          e.preventDefault();
          setIndex((i) => Math.max(0, i - 1));
          break;
        case "Enter":
          if (item !== undefined && onConfirm) {
            e.preventDefault();
            onConfirm(item);
          }
          break;
        case "Backspace":
          if (item !== undefined && onReject) {
            e.preventDefault();
            onReject(item);
          }
          break;
        case "o":
        case "O":
          if (item !== undefined && onOpen) {
            e.preventDefault();
            onOpen(item);
          }
          break;
        case "?":
          e.preventDefault();
          setHelpOpen(true);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, current, items, onConfirm, onReject, onOpen]);

  return { index: current, setIndex, helpOpen, setHelpOpen, active };
}
