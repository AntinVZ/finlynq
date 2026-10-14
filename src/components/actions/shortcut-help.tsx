"use client";

/** The `?` dialog: list shortcuts and switch them off (P8 stage 5). */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n";
import { useShortcutsEnabled } from "./use-list-keyboard";

const ROWS: Array<[string, MessageKey]> = [
  ["J / K", "shortcuts.move"],
  ["Enter", "shortcuts.confirm"],
  ["Backspace", "shortcuts.reject"],
  ["O", "shortcuts.open"],
  ["?", "shortcuts.help"],
];

export function ShortcutHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  const [enabled, setEnabled] = useShortcutsEnabled();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("shortcuts.intro")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {ROWS.map(([keys, label]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded border px-1.5 py-0.5 text-xs">{keys}</kbd>
              </dt>
              <dd>{t(label)}</dd>
            </div>
          ))}
        </dl>
        <label className="mt-2 flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("shortcuts.enabled")}
        </label>
      </DialogContent>
    </Dialog>
  );
}
