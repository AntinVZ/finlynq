"use client";

/**
 * Merchants settings (the gear at the top of Merchants): language, advanced
 * mode, auto-replace known spellings on import (the import hint) and
 * auto-merge close new spellings (the autopilot) with its threshold. Every switch saves at once through PUT /api/payees/settings.
 */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DictionaryCard } from "./dictionary-card";
import type { PayeeSettings } from "./payee-ui";
import { useStudioT } from "./i18n";
import { LanguagePicker } from "@/components/i18n/language-picker";

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

/**
 * P8: the type words, bank-operation patterns and the dictionary file — on
 * Merchants → Dictionaries & packs (they were in this dialog).
 */
export function WordListsSection({ settings, onSave, onImported }: { settings: PayeeSettings | null; onSave: (patch: Partial<PayeeSettings>) => void; onImported: () => void }) {
  const t = useStudioT();
  const disabled = !settings;
  return (
    <div className="space-y-6 text-sm">
      <section className="space-y-3" aria-label={t("settings.wordsTitle")}>
        <h3 className="font-medium">{t("settings.wordsTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings.wordsNote")}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <WordListField label={t("settings.typeWordsExtra")} value={settings?.typeWordsExtra} disabled={disabled} onSave={(v) => onSave({ typeWordsExtra: v })} placeholder={t("settings.typeWordsExtraPh")} />
          <WordListField label={t("settings.typeWordsOff")} value={settings?.typeWordsOff} disabled={disabled} onSave={(v) => onSave({ typeWordsOff: v })} placeholder={t("settings.typeWordsOffPh")} />
          <WordListField label={t("settings.bankOpsExtra")} value={settings?.bankOpsExtra} disabled={disabled} onSave={(v) => onSave({ bankOpsExtra: v })} placeholder={t("settings.bankOpsExtraPh")} />
          <WordListField label={t("settings.bankOpsOff")} value={settings?.bankOpsOff} disabled={disabled} onSave={(v) => onSave({ bankOpsOff: v })} placeholder={t("settings.bankOpsOffPh")} />
        </div>
      </section>
      <section className="border-t pt-3" aria-label={t("dictionary.file")}>
        <h3 className="font-medium mb-2">{t("dictionary.file")}</h3>
        <DictionaryCard onImported={onImported} />
      </section>
    </div>
  );
}

export function StudioSettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: PayeeSettings | null;
  onSave: (patch: Partial<PayeeSettings>) => void;
  onClose: () => void;
}) {
  const t = useStudioT();
  const disabled = !settings;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
          <DialogDescription>{t("settings.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <LanguagePicker />
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={settings?.importHint ?? false} disabled={disabled} onChange={(e) => onSave({ importHint: e.target.checked })} />
            <span>
              {t("settings.importHint")}
              <span className="block text-xs text-muted-foreground">{t("settings.importHintNote")}</span>
            </span>
          </label>
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              aria-label={t("settings.autopilot")}
              checked={settings?.autopilotEnabled ?? false}
              disabled={disabled}
              onChange={(e) => onSave({ autopilotEnabled: e.target.checked })}
            />
            <span className="flex-1">
              {t("settings.autopilot")}
              <span className="block text-xs text-muted-foreground">{t("settings.autopilotNote")}</span>
              <label className="mt-1 inline-flex items-center gap-2 text-xs">
                {t("settings.threshold")}
                <select
                  className="h-7 rounded-md border bg-background px-1 text-xs"
                  value={String(settings?.autopilotThreshold ?? 0.9)}
                  disabled={disabled || !settings?.autopilotEnabled}
                  onChange={(e) => onSave({ autopilotThreshold: Number(e.target.value) })}
                >
                  {[0.75, 0.8, 0.85, 0.9, 0.95, 0.99].map((v) => (
                    <option key={v} value={String(v)}>
                      {Math.round(v * 100)}%
                    </option>
                  ))}
                </select>
              </label>
            </span>
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={settings?.requireDirectoryPayee ?? false} disabled={disabled} onChange={(e) => onSave({ requireDirectoryPayee: e.target.checked })} />
            <span>
              {t("settings.requireDirectory")}
              <span className="block text-xs text-muted-foreground">{t("settings.requireDirectoryNote")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={settings?.advancedMode ?? false} disabled={disabled} onChange={(e) => onSave({ advancedMode: e.target.checked })} />
            <span>
              {t("settings.advanced")}
              <span className="block text-xs text-muted-foreground">{t("settings.advancedNote")}</span>
            </span>
          </label>
          <p className="border-t pt-3 text-xs text-muted-foreground">{t("settings.movedToDictionaries")}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
