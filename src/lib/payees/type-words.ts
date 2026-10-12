/**
 * Payee vocabulary (Payee Studio P6, B21 / B25): the words that say WHAT a
 * merchant is rather than WHO it is, and the wording of the bank's own
 * service rows. One file, extended by the user in the Studio settings.
 *
 *  - TYPE WORDS (`ресторан`, `АЗС`, `аптека`, `hotel`, …): stripped from a
 *    matching key's core, so the BRAND decides the payee — `Ресторан Дача` ≠
 *    `Ресторан Липки`, `ОККО 123` = `АЗС ОККО 456`. A payee that is nothing
 *    but type words (`Ресторан`) has no brand: it is never clustered and
 *    never proposed as a merchant. Some words carry a merchant-type HINT
 *    (P6 stage 3) — a suggestion, never assigned without confirmation.
 *  - BANK OPERATIONS (`комісія`, `переказ власних коштів`, `відсотки`, …):
 *    the bank's own rows. They get the merchant type "Банківські операції",
 *    are not clustered as merchants and stay out of the merchant spend tops.
 *
 * Words are compared through `payeeMatchKey`, so Ukrainian, Russian, English
 * and transliterated spellings of one word meet (`аптека` / `apteka`,
 * `готель` / `hotel`).
 */
import { normalizeForMatch } from "@/lib/text-normalize";
import { payeeMatchKey, PATRONYMIC_TOKEN_RE } from "./match-key";

/** A merchant-type suggestion: group → position (stage 3 dictionary). */
export type MerchantTypeHint = { group: string; name: string };

const CAFE: MerchantTypeHint = { group: "Кафе, ресторани, бари", name: "Кафе" };
const RESTAURANT: MerchantTypeHint = { group: "Кафе, ресторани, бари", name: "Ресторани" };
const BAR: MerchantTypeHint = { group: "Кафе, ресторани, бари", name: "Бари" };
const PHARMACY: MerchantTypeHint = { group: "Аптеки", name: "Аптеки" };
const HOTEL: MerchantTypeHint = { group: "Готелі", name: "Готелі" };
const FUEL: MerchantTypeHint = { group: "Пальне (АЗС)", name: "Пальне (АЗС)" };

/**
 * Default type words (uk, ru, en, transliterated). Multi-word entries
 * (`медичний центр`) are removed only as a whole phrase.
 */
export const DEFAULT_TYPE_WORDS: ReadonlyArray<{ word: string; hint?: MerchantTypeHint }> = [
  // cafés
  ...["кафе", "cafe", "café", "kafe", "кав'ярня", "kaviarnia", "кофейня", "kofeinia", "coffee shop", "піцерія", "пиццерия", "pizzeria", "pitseriia", "фастфуд", "fastfood", "fast food", "пекарня", "pekarnia", "bakery", "кондитерська", "кондитерская", "konditerska", "їдальня", "столовая", "stolova"].map((word) => ({ word, hint: CAFE })),
  // restaurants
  ...["ресторан", "restaurant", "restoran", "бістро", "бистро", "bistro", "гастробар", "gastrobar", "steakhouse", "стейкхаус"].map((word) => ({ word, hint: RESTAURANT })),
  // bars
  ...["бар", "bar", "паб", "pub", "пивбар", "лаунж", "lounge"].map((word) => ({ word, hint: BAR })),
  // pharmacies
  ...["аптека", "apteka", "pharmacy", "фармація", "farmatsiia", "фармация", "аптечний пункт"].map((word) => ({ word, hint: PHARMACY })),
  // hotels
  ...["готель", "hotel", "гостиница", "отель", "hostel", "хостел", "мотель", "motel", "апартаменти", "apartments"].map((word) => ({ word, hint: HOTEL })),
  // fuel
  ...["азс", "azs", "заправка", "zapravka", "автозаправка", "gas station", "fuel station", "petrol station", "станція", "станция", "stantsiia"].map((word) => ({ word, hint: FUEL })),
  // shops and services (no hint: too broad)
  ...["магазин", "mahazyn", "magazin", "шоп", "shop", "store", "супермаркет", "supermarket", "мінімаркет", "минимаркет", "minimarket", "гіпермаркет", "гипермаркет", "hypermarket", "бутик", "boutique", "салон", "salon", "медичний центр", "медицинский центр", "medychnyi tsentr", "medical center", "medical centre", "медцентр", "клініка", "клиника", "clinic", "klinika", "стоматологія", "стоматология", "dental"].map((word) => ({ word })),
];

/**
 * Default bank-operation patterns. A pattern matches whole words of the
 * normalized payee; a trailing `*` makes its last word a prefix (`відсотк*`
 * → відсотки, відсотків).
 */
export const DEFAULT_BANK_OPERATIONS: readonly string[] = [
  "комісія*", "комісії*", "комиссия*", "комиссии*", "commission*", "bank fee", "service fee",
  "переказ власних коштів", "переказ між своїми рахунками", "переказ між власними рахунками", "перевод собственных средств", "перевод между своими счетами", "own account transfer", "transfer between own accounts",
  "відсотк*", "проценты", "нарахування відсотків", "interest payment", "interest accrued",
  "поповнення рахунку", "поповнення картки", "поповнення депозиту", "пополнение счета", "пополнение карты",
  "зняття готівки", "снятие наличных", "cash withdrawal", "видача готівки",
  "погашення кредиту", "погашення заборгованості", "погашение кредита",
  "обслуговування рахунку", "обслуговування картки", "плата за обслуговування", "обслуживание счета",
  "конвертація валют*", "обмін валют*", "купівля валюти", "продаж валюти",
  "кешбек", "cashback",
];

export type VocabularyOptions = {
  /** User additions (Studio settings). */
  typeWordsExtra?: readonly string[];
  /** Default words the user switched off. */
  typeWordsOff?: readonly string[];
  bankOpsExtra?: readonly string[];
  bankOpsOff?: readonly string[];
};

type TypePhrase = { word: string; tokens: string[]; hint: MerchantTypeHint | null };
type BankOp = { pattern: string; re: RegExp };

export type PayeeVocabulary = {
  /** Folded key token sequences, longest first. */
  phrases: TypePhrase[];
  bankOps: BankOp[];
};

/** "Група → Позиція" / "Група / Позиція" / a single group name → a hint. */
function hintOfText(text: string): MerchantTypeHint | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const m = t.match(/^(.+?)\s*(?:→|->|>|\/)\s*(.+)$/);
  return m ? { group: m[1].trim(), name: m[2].trim() } : { group: t, name: t };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compileBankOp(pattern: string): BankOp | null {
  const p = normalizeForMatch(pattern).replace(/\s+/g, " ").trim();
  if (p.replace(/\*$/, "").length < 3) return null;
  const prefix = p.endsWith("*");
  const body = escapeRe(prefix ? p.slice(0, -1) : p).replace(/ /g, "\\s+");
  return { pattern: p, re: new RegExp(`(?:^|[^\\p{L}\\p{N}])${body}${prefix ? "" : "(?![\\p{L}\\p{N}])"}`, "u") };
}

const cleanList = (l: readonly string[] | undefined) => (l ?? []).map((w) => w.replace(/\s+/g, " ").trim()).filter((w) => w.length > 0 && w.length <= 60);

/** Build a vocabulary: the defaults, minus what the user switched off, plus their own words. */
export function buildVocabulary(opts: VocabularyOptions = {}): PayeeVocabulary {
  const off = new Set(cleanList(opts.typeWordsOff).map((w) => payeeMatchKey(w)));
  const phrases = new Map<string, TypePhrase>();
  const add = (word: string, hint: MerchantTypeHint | null) => {
    const key = payeeMatchKey(word);
    if (!key || off.has(key) || phrases.has(key)) return;
    phrases.set(key, { word, tokens: key.split(" "), hint });
  };
  for (const w of DEFAULT_TYPE_WORDS) add(w.word, w.hint ?? null);
  // P6.2 (B30): a user word may carry a hint — `кальянна = Кафе, ресторани, бари → Бари`.
  for (const w of cleanList(opts.typeWordsExtra)) {
    const m = w.match(/^(.+?)\s*=\s*(.+)$/);
    add(m ? m[1].trim() : w, m ? hintOfText(m[2]) : null);
  }
  const opsOff = new Set(cleanList(opts.bankOpsOff).map((p) => normalizeForMatch(p)));
  const bankOps: BankOp[] = [];
  const seen = new Set<string>();
  for (const p of [...DEFAULT_BANK_OPERATIONS, ...cleanList(opts.bankOpsExtra)]) {
    const op = compileBankOp(p);
    if (!op || opsOff.has(op.pattern) || seen.has(op.pattern)) continue;
    seen.add(op.pattern);
    bankOps.push(op);
  }
  // Longest first: the most specific wording names the operation.
  bankOps.sort((a, b) => b.pattern.length - a.pattern.length);
  return { phrases: [...phrases.values()].sort((a, b) => b.tokens.length - a.tokens.length), bankOps };
}

let defaultVocab: PayeeVocabulary | null = null;
/** The defaults alone (built lazily: match-key and this module import each other). */
export function defaultVocabulary(): PayeeVocabulary {
  return (defaultVocab ??= buildVocabulary());
}

export type BrandCore = {
  /** Key tokens left: no one-letter tokens, no type words (unless that would leave nothing). */
  core: string;
  /** The brand tokens (= core tokens when anything specific is left). */
  brandTokens: string[];
  /** Type words removed (as listed in the vocabulary). */
  removed: string[];
  /** The key is nothing but type words / one-letter tokens: no brand. */
  typeOnly: boolean;
  /** Merchant-type hint from the first removed word that carries one. */
  hint: MerchantTypeHint | null;
  /** P6.2 (B30): every removed word that carries a hint, in order. */
  hints: Array<{ word: string; hint: MerchantTypeHint }>;
};

/**
 * Split a matching key into its brand core: drop one-letter tokens and the
 * vocabulary's type words. When nothing but type words would be left the key
 * has no brand (`typeOnly`) and `core` is the key without one-letter tokens.
 */
export function brandCoreOfKey(key: string, vocab: PayeeVocabulary = defaultVocabulary()): BrandCore {
  const tokens = key.split(" ").filter(Boolean);
  const long = tokens.filter((t) => t.length > 1);
  const base = long.length ? long : tokens;
  const removed: string[] = [];
  const hints: BrandCore["hints"] = [];
  const keep: string[] = [];
  for (let i = 0; i < base.length; ) {
    const p = vocab.phrases.find((ph) => ph.tokens.every((t, j) => base[i + j] === t));
    if (p) {
      removed.push(p.word);
      if (p.hint) hints.push({ word: p.word, hint: p.hint });
      i += p.tokens.length;
      continue;
    }
    keep.push(base[i]);
    i++;
  }
  const hint = hints[0]?.hint ?? null;
  if (!keep.length) return { core: base.join(" "), brandTokens: [], removed, typeOnly: removed.length > 0, hint, hints };
  return { core: keep.join(" "), brandTokens: keep, removed, typeOnly: false, hint, hints };
}

const sameHint = (a: MerchantTypeHint, b: MerchantTypeHint) =>
  normalizeForMatch(a.group) === normalizeForMatch(b.group) && normalizeForMatch(a.name) === normalizeForMatch(b.name);

/**
 * P6.2 (B30): the matching keys of every type word that means the same as
 * `word` — the words sharing its merchant-type hint (`аптека` → apteka,
 * pharmacy, фармація…). A word without a hint (or not in the vocabulary)
 * stands for itself only.
 */
export function typeWordSynonymKeys(word: string, vocab: PayeeVocabulary = defaultVocabulary()): string[] {
  const key = payeeMatchKey(word);
  if (!key) return [];
  const own = vocab.phrases.find((p) => p.tokens.join(" ") === key);
  if (!own?.hint) return [key];
  return [...new Set([key, ...vocab.phrases.filter((p) => p.hint && sameHint(p.hint, own.hint!)).map((p) => p.tokens.join(" "))])];
}

/** The bank-operation pattern a payee matches, or null. */
export function bankOperationOf(payee: string | null | undefined, vocab: PayeeVocabulary = defaultVocabulary()): string | null {
  const s = normalizeForMatch(payee ?? "");
  if (!s) return null;
  for (const op of vocab.bankOps) if (op.re.test(s)) return op.pattern;
  return null;
}

/**
 * A private person's name as a sorted token set (B24): patronymics and
 * one-letter initials dropped, Latin / Cyrillic folded, word order ignored —
 * `Пасічник Олександр` and `Олександр Володимирович Пасічник` meet. Null
 * when fewer than two name words are left or a token isn't a plain word.
 */
export function personNameKey(kept: readonly string[]): string | null {
  const words = kept.filter((t) => !PATRONYMIC_TOKEN_RE.test(t));
  if (words.length < 2 || words.length > 4) return null;
  if (!words.every((w) => /^[\p{L}'’-]+$/u.test(w))) return null;
  const keys = words.map((w) => payeeMatchKey(w)).filter((k) => k.length > 1);
  if (keys.length < 2) return null;
  return keys.sort().join(" ");
}
