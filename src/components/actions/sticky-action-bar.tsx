"use client";

/**
 * Decision buttons that stay under the thumb (P8 stage 5): on narrow screens
 * a bar fixed to the bottom (above the app's bottom navigation, respecting
 * the safe area); on wider screens an ordinary row at the end of the content.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StickyActionBar({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn(
        "fixed inset-x-0 bottom-16 z-40 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur",
        "md:static md:z-auto md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
