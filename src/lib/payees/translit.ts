/**
 * Transliteration as a plugin (P8 stage 7). A plugin turns one script into
 * Latin letters so the matching key of «Сільпо» and «Silpo» is the same.
 * The matching key uses the BUILT-IN chain only (today: Ukrainian-first
 * Cyrillic), so keys stay stable for everyone; a country pack names the
 * plugin it relies on and the «Словники і пакети» tab says whether it is
 * available. Adding a script = one plugin object here.
 *
 * Pure (web and server).
 */

export type TranslitPlugin = {
  id: string;
  /** The script it handles (ISO 15924), e.g. "Cyrl". */
  script: string;
  /** Letters it handles; text without them is returned unchanged. */
  detect: RegExp;
  /** Lowercase input → Latin. */
  toLatin: (s: string) => string;
};

const fromTable = (table: Record<string, string>) => (s: string) => {
  let out = "";
  for (const ch of s) out += table[ch] ?? ch;
  return out;
};

/** Ukrainian-first Cyrillic → Latin (with the Russian-only letters). Moved here unchanged from match-key.ts. */
const CYR_TO_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z",
  и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ь: "", ю: "iu", я: "ia", ъ: "", ы: "y", э: "e", ё: "e",
};

export const CYRILLIC_UK: TranslitPlugin = { id: "cyrl-uk", script: "Cyrl", detect: /[Ѐ-ӿ]/, toLatin: fromTable(CYR_TO_LAT) };

/** A starter for another script (Greek, ELOT 743 simplified) — registered, not in the matching chain. */
export const GREEK_EL: TranslitPlugin = {
  id: "grek-el",
  script: "Grek",
  detect: /[Ͱ-Ͽ]/,
  toLatin: fromTable({
    α: "a", ά: "a", β: "v", γ: "g", δ: "d", ε: "e", έ: "e", ζ: "z", η: "i", ή: "i", θ: "th", ι: "i", ί: "i", ϊ: "i", ΐ: "i",
    κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o", ό: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", ύ: "y", ϋ: "y", ΰ: "y",
    φ: "f", χ: "ch", ψ: "ps", ω: "o", ώ: "o",
  }),
};

const REGISTRY = new Map<string, TranslitPlugin>([CYRILLIC_UK, GREEK_EL].map((p) => [p.id, p]));

/** The plugins the matching key uses, in order. Changing it changes every stored key — don't, without a migration. */
export const MATCHING_CHAIN: readonly string[] = ["cyrl-uk"];

export function registerTranslit(plugin: TranslitPlugin): void {
  REGISTRY.set(plugin.id, plugin);
}

export function translitPlugin(id: string): TranslitPlugin | undefined {
  return REGISTRY.get(id);
}

export function translitPlugins(): TranslitPlugin[] {
  return [...REGISTRY.values()];
}

/** Run a chain of plugins over lowercase text. */
export function transliterate(s: string, chain: readonly string[] = MATCHING_CHAIN): string {
  let out = s;
  for (const id of chain) {
    const p = REGISTRY.get(id);
    if (p && p.detect.test(out)) out = p.toLatin(out);
  }
  return out;
}
