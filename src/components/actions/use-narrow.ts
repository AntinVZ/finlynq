"use client";

/** True on narrow screens (below Tailwind `sm`, 640px) — cards and bottom sheets instead of tables and dialogs. */

import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 639px)";

export function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(QUERY);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(QUERY).matches : false),
    () => false,
  );
}
