"use client";

/**
 * PayeeCombobox is now <PayeePicker> (P8 stage 4): the same field, with
 * explicit free text («Додати в довідник» / «Тільки текст»), «Рекомендовано:
 * X» and a bottom sheet on phones. Kept as an alias for existing imports.
 */
export { PayeePicker as PayeeCombobox, type PayeeSuggestion, type PayeeFieldState } from "./payee-picker";
