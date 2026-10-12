"use client";

/**
 * Payee Studio settings (the gear at the top of Settings → Payees): advanced
 * mode, auto-replace known spellings on import (the import hint), auto-merge
 * close new spellings (the autopilot) with its threshold, and the dictionary
 * file. Every switch saves at once through PUT /api/payees/settings.
 */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DictionaryCard } from "./dictionary-card";
import type { PayeeSettings } from "./payee-ui";

/** A one-entry-per-line list that saves on blur. Remounts (via key) when the saved value changes. */
function WordListField({ label, value, disabled, onSave, placeholder }: { label: string; value?: string[]; disabled: boolean; onSave: (v: string[]) => void; placeholder?: string }) {
  const saved = (value ?? []).join("\n");
  return (
    <label className="block text-xs">
      <span className="font-medium">{label}</span>
      <textarea
        key={saved}
        aria-label={label}
        className="mt-1 block w-full min-h-16 rounded-md border bg-background p-2 text-xs"
        defaultValue={saved}
        disabled={disabled}
        placeholder={placeholder}
        onBlur={(e) => {
          const next = e.target.value.split("\n").map((w) => w.trim()).filter(Boolean);
          if (next.join("\n") !== saved) onSave(next);
        }}
      />
    </label>
  );
}

export function StudioSettingsDialog({
  settings,
  onSave,
  onClose,
  onImported,
}: {
  settings: PayeeSettings | null;
  onSave: (patch: Partial<PayeeSettings>) => void;
  onClose: () => void;
  onImported: () => void;
}) {
  const disabled = !settings;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Payee Studio settings</DialogTitle>
          <DialogDescription>Changes save immediately. Both automatic options are off by default and every run they make can be undone in Changes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={settings?.importHint ?? false} disabled={disabled} onChange={(e) => onSave({ importHint: e.target.checked })} />
            <span>
              Auto-replace known spellings on import
              <span className="block text-xs text-muted-foreground">
                When an imported row or a new transaction (web, AI assistant, email, bank connection) has a payee that matches an alias, it is
                saved under the canonical name. Bank statement rows keep their original text.
              </span>
            </span>
          </label>
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              aria-label="Auto-merge close new spellings"
              checked={settings?.autopilotEnabled ?? false}
              disabled={disabled}
              onChange={(e) => onSave({ autopilotEnabled: e.target.checked })}
            />
            <span className="flex-1">
              Auto-merge close new spellings
              <span className="block text-xs text-muted-foreground">
                On import, a payee not in the directory that is very close to exactly one entry (at or above the threshold) is renamed and its
                spelling added as an alias. Never for people or sole proprietors, never on a card-number match.
              </span>
              <label className="mt-1 inline-flex items-center gap-2 text-xs">
                Threshold
                <select
                  className="h-7 rounded-md border bg-background px-1 text-xs"
                  value={String(settings?.autopilotThreshold ?? 0.9)}
                  disabled={disabled || !settings?.autopilotEnabled}
                  onChange={(e) => onSave({ autopilotThreshold: Number(e.target.value) })}
                >
                  {[0.75, 0.8, 0.85, 0.9, 0.95, 0.99].map((t) => (
                    <option key={t} value={String(t)}>
                      {Math.round(t * 100)}%
                    </option>
                  ))}
                </select>
              </label>
            </span>
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={settings?.advancedMode ?? false} disabled={disabled} onChange={(e) => onSave({ advancedMode: e.target.checked })} />
            <span>
              Advanced mode
              <span className="block text-xs text-muted-foreground">
                Show requisites on payee pages: IBAN, tax id (ІПН / РНОКПП), EDRPOU, card last 4 digits, crypto wallet. Stored encrypted; full card
                numbers are never kept.
              </span>
            </span>
          </label>
          <div className="border-t pt-3 space-y-3">
            <h3 className="font-medium">Словник: слова-типи і банківські операції</h3>
            <p className="text-xs text-muted-foreground">
              Слова-типи (ресторан, АЗС, аптека, hotel…) не входять у ядро назви — платника визначає бренд: «Ресторан Дача» ≠ «Ресторан Липки».
              Банківські операції (комісія, переказ власних коштів, відсотки…) не є мерчантами і не потрапляють у топи витрат. По одному на рядок;
              зберігається, коли поле втрачає фокус. Вбудований список доповнюється вашими словами; вбудовані можна вимкнути.
            </p>
            <WordListField label="Мої слова-типи" value={settings?.typeWordsExtra} disabled={disabled} onSave={(v) => onSave({ typeWordsExtra: v })} placeholder={"шиномонтаж\nкальянна"} />
            <WordListField label="Вимкнути вбудовані слова-типи" value={settings?.typeWordsOff} disabled={disabled} onSave={(v) => onSave({ typeWordsOff: v })} placeholder="салон" />
            <WordListField label="Мої банківські операції (* в кінці — префікс)" value={settings?.bankOpsExtra} disabled={disabled} onSave={(v) => onSave({ bankOpsExtra: v })} placeholder={"плата за SMS\nстрахування картк*"} />
            <WordListField label="Вимкнути вбудовані банківські операції" value={settings?.bankOpsOff} disabled={disabled} onSave={(v) => onSave({ bankOpsOff: v })} placeholder="кешбек" />
          </div>
          <div className="border-t pt-3">
            <h3 className="font-medium mb-2">Dictionary file</h3>
            <DictionaryCard onImported={onImported} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
