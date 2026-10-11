/**
 * Payee matching keys (Payee Studio).
 *
 * The same counterparty reaches the ledger under many spellings: `Epicentr`,
 * `Епіцентр`, `EPITCENTR K10 KYIV 360616`, `Colin's` / `Colin’s`,
 * `Атб Маркет` / `ATB MARKET`. `payeeMatchKey` folds all of those to one
 * comparison key so they can be grouped, clustered and matched to aliases.
 *
 * Steps (comparison only — never persisted as plaintext, never written back):
 *   1. `normalizeForMatch` (case, apostrophes, dashes, Unicode, whitespace);
 *   2. strip card-terminal noise: POS / PURCHASE-style prefixes, web prefixes
 *      and TLDs, terminal codes (`K10`), long numbers, card masks, dates,
 *      amounts, trailing city / country words;
 *   3. drop legal-form words (ТОВ, LLC, ФОП, …) — the type guess keeps them;
 *   4. transliterate Cyrillic to Latin and fold the spelling differences
 *      transliteration produces (`ц`/`ts`/`tc`/`c` → `k`, `и`/`y`/`j` → `i`,
 *      `г`/`g` → `h`, doubled letters, …), so Latin and Cyrillic spellings of
 *      one name meet.
 *
 * This is NOT `normalizeForLookup` / the Stream D `name_lookup` HMAC (that
 * normalization is persisted and indexed — see crypto/encrypted-columns.ts)
 * and must never be used for it.
 */
import { normalizeForMatch } from "@/lib/text-normalize";

// ─── transliteration ───────────────────────────────────────────────────────

/** Ukrainian-first Cyrillic → Latin (with the Russian-only letters). */
const CYR_TO_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z",
  и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ь: "", ю: "iu", я: "ia", ъ: "", ы: "y", э: "e", ё: "e",
};

const HAS_CYRILLIC = /[Ѐ-ӿ]/;

/** Cyrillic letters → Latin; everything else unchanged. Input is lowercase. */
export function transliterateToLatin(s: string): string {
  if (!HAS_CYRILLIC.test(s)) return s;
  let out = "";
  for (const ch of s) out += CYR_TO_LAT[ch] ?? ch;
  return out;
}

/**
 * Fold one lowercase Latin token to its phonetic skeleton. Multi-letter
 * sounds go to placeholders first so the single-letter folds below can't
 * split them (`ch` must not become `kh`).
 */
function foldLatin(token: string): string {
  let t = token
    .replace(/shch|sch/g, "S")
    .replace(/tch|ch/g, "C")
    .replace(/sh/g, "S")
    .replace(/zh/g, "Z")
    .replace(/kh/g, "h")
    .replace(/ck/g, "k")
    .replace(/ts|tc|tz|cz/g, "c")
    .replace(/ph/g, "f")
    .replace(/w/g, "v")
    .replace(/x/g, "ks")
    .replace(/q/g, "k")
    .replace(/[yj]/g, "i")
    .replace(/c/g, "k")
    .replace(/g/g, "h");
  t = t.replace(/^ie/, "e");
  t = t.replace(/[^a-zSCZ0-9]/g, "");
  // Doubled letters: `Bulochkka`, `Colinn`, `Kyyiv`.
  t = t.replace(/(.)\1+/g, "$1");
  return t.replace(/S/g, "sh").replace(/C/g, "ch").replace(/Z/g, "zh");
}

// ─── terminal noise ─────────────────────────────────────────────────────────

/** Leading words that card terminals and banks prepend. Matched repeatedly. */
const PREFIX_RE =
  /^(?:pos|purchase|card purchase|payment|pmt|оплата|покупка|покупка товару|оплата товарів|apple pay|google pay|gpay|liqpay|wfp|www\.)[\s:*#.-]+/;

/** Cities / countries banks append to a merchant name. Dropped only after the first token. */
const PLACE_WORDS = new Set([
  "kyiv", "kiev", "kyyiv", "kyjiv", "київ", "киев", "lviv", "lvov", "львів", "львов",
  "odesa", "odessa", "одеса", "одесса", "kharkiv", "kharkov", "харків", "харьков",
  "dnipro", "дніпро", "днепр", "zaporizhzhia", "запоріжжя", "vinnytsia", "вінниця",
  "poltava", "полтава", "chernihiv", "чернігів", "irpin", "ірпінь", "bucha", "буча",
  "brovary", "бровари", "uzhhorod", "ужгород", "lutsk", "луцьк", "rivne", "рівне",
  "ternopil", "тернопіль", "khmelnytskyi", "хмельницький", "cherkasy", "черкаси",
  "sumy", "суми", "mykolaiv", "миколаїв", "kherson", "херсон", "zhytomyr", "житомир",
  "ivano-frankivsk", "івано-франківськ", "chernivtsi", "чернівці", "kropyvnytskyi",
  "london", "dublin", "vilnius", "warsaw", "warszawa", "amsterdam", "limassol", "nicosia",
  "tallinn", "riga", "luxembourg", "berlin", "prague", "praha",
  "ua", "ukr", "ukraine", "україна", "ukraina", "gb", "uk", "lt", "lv", "ee", "pl", "de",
  "nl", "cy", "ie", "mt", "us", "usa", "cz", "lu",
]);

/** Currency codes a bank may append after the amount. */
const CURRENCY_WORDS = new Set(["uah", "грн", "usd", "eur", "gbp", "pln", "usdt"]);

/** Legal-form words: kept for the type guess, dropped from the key. */
const LEGAL_WORDS = new Set([
  "тов", "тзов", "пп", "прат", "пат", "ат", "фоп", "флп", "спд", "чп", "ооо",
  "fop", "flp", "spd", "tov", "llc", "ltd", "inc", "gmbh", "corp", "plc", "sa", "ag", "bv",
]);

/** Splits on whitespace and on punctuation that never belongs inside a name. */
const TOKEN_SPLIT_RE = /[\s,;:/\\|*#№()[\]{}"«»<>!?+=_~]+/;

/** A token that is noise wherever it appears after the first one. */
function isNoiseToken(tok: string, index: number, total: number): boolean {
  if (index === 0) return false;
  const last = index === total - 1;
  if (/^\d{4,}$/.test(tok)) return true; // terminal / reference numbers
  if (last && /^\d{3}$/.test(tok)) return true; // short numeric tail
  if (/^\d+[.,]\d{1,2}$/.test(tok)) return true; // amounts
  if (/^\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?$/.test(tok)) return true; // dates / times
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(tok)) return true;
  if (/^[\p{L}]{1,2}\d+$/u.test(tok)) return true; // terminal codes: K10, T23
  if (/[x*•]{2,}/.test(tok) && /\d/.test(tok)) return true; // card masks 4149xx1234
  // Alphanumeric ids with three or more digits mixed in letters (A1B2C3D4E5).
  if (tok.length >= 6 && (tok.match(/\d/g)?.length ?? 0) >= 3 && /[a-z]/.test(tok)) return true;
  if (CURRENCY_WORDS.has(tok)) return true;
  return false;
}

/** Strip web decorations from a token: `binance.com` → `binance`. */
function stripWeb(tok: string): string {
  return tok.replace(/^www\./, "").replace(/\.(?:com|ua|net|org|io|co|eu|com\.ua)$/, "");
}

export type PayeeTokens = {
  /** Tokens kept after noise stripping (normalized, not transliterated). */
  kept: string[];
  /** True when something beyond case / spacing / apostrophes was stripped. */
  noisy: boolean;
  /** The legal-form words seen (normalized). */
  legal: string[];
};

/** Normalize and split a payee into its meaningful tokens. */
export function payeeTokens(raw: string | null | undefined): PayeeTokens {
  let s = normalizeForMatch(raw ?? "");
  let noisy = false;
  for (let guard = 0; guard < 4; guard++) {
    const next = s.replace(PREFIX_RE, "");
    if (next === s) break;
    s = next;
    noisy = true;
  }
  const parts = s.split(TOKEN_SPLIT_RE).map((p) => p.replace(/^[-.'’]+|[-.'’]+$/g, "")).filter(Boolean);
  const kept: string[] = [];
  const legal: string[] = [];
  // Places are dropped from the tail only (`Kyiv Food Market` keeps `kyiv`):
  // walk back over trailing noise / place words first.
  let end = parts.length;
  while (end > 1) {
    const tok = stripWeb(parts[end - 1]);
    if (PLACE_WORDS.has(tok) || isNoiseToken(tok, end - 1, end)) {
      end--;
      noisy = true;
      continue;
    }
    break;
  }
  for (let i = 0; i < end; i++) {
    const tok = stripWeb(parts[i]);
    if (tok !== parts[i]) noisy = true;
    if (LEGAL_WORDS.has(tok)) {
      legal.push(tok);
      continue;
    }
    if (isNoiseToken(tok, i, end)) {
      noisy = true;
      continue;
    }
    kept.push(tok);
  }
  // A payee that is nothing but legal words / noise keeps its first token.
  if (kept.length === 0 && parts.length > 0) kept.push(stripWeb(parts[0]));
  return { kept, noisy, legal };
}

/**
 * The comparison key of a payee: noise stripped, transliterated, folded.
 * Empty for an empty payee. Two payees with the same key are one name.
 */
export function payeeMatchKey(raw: string | null | undefined): string {
  return keyFromTokens(payeeTokens(raw).kept);
}

function keyFromTokens(tokens: readonly string[]): string {
  return tokens
    .map((t) => foldLatin(transliterateToLatin(t.replace(/['’ʼ`]/g, ""))))
    .filter(Boolean)
    .join(" ");
}

/**
 * The key without one-letter tokens (`epikentr k` → `epikentr`,
 * `davidzon o m` → `davidzon`). Used to pair near-identical names in
 * clustering; never for exact matching.
 */
export function coreOfKey(key: string): string {
  const toks = key.split(" ").filter((t) => t.length > 1);
  return toks.length ? toks.join(" ") : key;
}

/**
 * A readable version of the raw payee with the terminal noise removed, for
 * suggesting a canonical name: `EPITCENTR K10 KYIV 360616` → `Epitcentr`.
 * ALL-CAPS results are title-cased; anything else keeps its letter case.
 */
export function cleanPayeeDisplay(raw: string | null | undefined): string {
  const original = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!original) return "";
  const { kept, legal } = payeeTokens(original);
  // Rebuild from the original words so letter case and apostrophes survive.
  const wanted = new Set([...kept, ...legal]);
  const words = (original.match(/[^\s,;:/\\|*#№()[\]{}"«»<>!?+=_~]+/g) ?? []).filter((w) => {
    const n = stripWeb(normalizeForMatch(w).replace(/^[-.'’]+|[-.'’]+$/g, ""));
    return wanted.has(n);
  });
  let out = words.length ? words.join(" ") : original;
  out = out.replace(/^(?:pos|purchase|payment)\s+/i, "").replace(/\.(?:com|ua)$/i, "").trim() || out;
  const letters = out.replace(/[^\p{L}]/gu, "");
  if (letters && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    out = out
      .toLowerCase()
      .replace(/(^|[\s"'«(-])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase())
      .split(" ")
      .map((w) => (LEGAL_WORDS.has(normalizeForMatch(w)) ? w.toUpperCase() : w))
      .join(" ");
  }
  return out;
}

// ─── counterparty type guess ────────────────────────────────────────────────

export const PAYEE_TYPES = [
  "retail",
  "service",
  "bank",
  "government",
  "person",
  "sole_proprietor",
  "company",
  "other",
] as const;
export type PayeeType = (typeof PAYEE_TYPES)[number];

export type TypeGuess = {
  type: PayeeType;
  /** 0–1: how sure the guess is. `other` is always 0.2. */
  confidence: number;
  /** A private person or a sole proprietor (ФОП): never merged automatically. */
  isPerson: boolean;
  reason: string;
};

const PATRONYMIC_RE = /(?:ович|евич|йович|івна|ївна|овна|евна|ічна|ична)$/;
const PATRONYMIC_LAT_RE = /(?:ovych|ovich|evych|evich|yovych|ivna|yivna|ovna|evna|ichna)$/;
const SOLE_PROP_RE = /^(?:фоп|флп|спд|fop|flp|spd|фізична особа[- ]підприємець|fizychna osoba[- ]pidpryiemets)\b/;
const INITIALS_RE = /^[\p{L}'’-]{2,}\s+\p{L}\.\s*\p{L}\.?$/u;
const BANK_RE = /\b(?:bank|банк|приватбанк|privatbank|monobank|монобанк|ощадбанк|oschadbank|raiffeisen|райффайзен|pumb|пумб|sense bank|абанк|a-bank|universal bank)\b/;
const GOV_RE = /(?:податков|казначей|treasury|\bдпс\b|\bпфу\b|пенсійн|\bdps\b|tax office|держ|gov\.ua|\bдія\b|\bdiia\b|митн|customs|суд\b)/;
const COMPANY_RE = /\b(?:тов|тзов|прат|пат|ат|ооо|llc|ltd|inc|gmbh|corp|plc)\b/;
const SERVICE_RE = /\b(?:binance|bybit|netflix|spotify|google|apple|youtube|uber|bolt|uklon|glovo|wolt|patreon|steam|playstation|microsoft|adobe|openai|anthropic|aws|amazon|paypal|wise|revolut|kyivstar|київстар|vodafone|lifecell|volia|воля|nova poshta|нова пошта|ukrposhta|укрпошта|meest|liqpay|portmone|easypay|city24|ipay)\b/;
const RETAIL_RE = /(?:market|маркет|supermarket|супермаркет|\bshop\b|\bшоп\b|магазин|store|аптека|pharmacy|apteka|кафе|cafe|coffee|кава|restaurant|ресторан|піца|pizza|бакалія|продукти|silpo|сільпо|\bатб\b|\batb\b|novus|новус|fozzy|фоззі|varus|варус|metro|метро|auchan|ашан|епіцентр|epicentr|rozetka|розетка|comfy|фокстрот|foxtrot|eldorado|ельдорадо|aldi|lidl|zara|h&m|ikea|макдональдз|mcdonald|kfc|пекарня|bakery|bulochka|булочка)/;

/**
 * Guess what kind of counterparty a payee is, from its own text only.
 * Deliberately conservative: an unrecognized name is `other` (low confidence),
 * never a guess dressed up as certain.
 */
export function guessPayeeType(raw: string | null | undefined): TypeGuess {
  const s = normalizeForMatch(raw ?? "");
  if (!s) return { type: "other", confidence: 0.2, isPerson: false, reason: "empty payee" };
  if (SOLE_PROP_RE.test(s)) return { type: "sole_proprietor", confidence: 0.9, isPerson: true, reason: "starts with ФОП / FOP" };
  const words = s.split(/\s+/).filter(Boolean);
  const patronymic = words.some((w) => PATRONYMIC_RE.test(w) || PATRONYMIC_LAT_RE.test(w));
  if (patronymic && words.length >= 2 && words.length <= 4) {
    return { type: "person", confidence: 0.85, isPerson: true, reason: "full name with a patronymic" };
  }
  if (INITIALS_RE.test((raw ?? "").trim())) {
    return { type: "person", confidence: 0.6, isPerson: true, reason: "surname with initials" };
  }
  if (GOV_RE.test(s)) return { type: "government", confidence: 0.7, isPerson: false, reason: "tax / state body wording" };
  if (BANK_RE.test(s)) return { type: "bank", confidence: 0.7, isPerson: false, reason: "bank name" };
  if (SERVICE_RE.test(s)) return { type: "service", confidence: 0.7, isPerson: false, reason: "known online service" };
  if (RETAIL_RE.test(s)) return { type: "retail", confidence: 0.6, isPerson: false, reason: "shop / food wording" };
  if (COMPANY_RE.test(s)) return { type: "company", confidence: 0.6, isPerson: false, reason: "legal form (ТОВ / LLC …)" };
  return { type: "other", confidence: 0.2, isPerson: false, reason: "no type signal in the name" };
}

// ─── similarity ─────────────────────────────────────────────────────────────

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 1 − distance / longer length, in [0, 1]. */
export function keySimilarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;
  return 1 - editDistance(a, b) / longer;
}

/**
 * Why two spellings share a key, in plain words: letter case / spacing /
 * apostrophes, terminal noise, or transliteration.
 */
export function spellingDifferenceReason(a: string, b: string): string {
  if (normalizeForMatch(a) === normalizeForMatch(b)) return "letter case, spacing or apostrophes";
  const ta = payeeTokens(a).kept.join(" ");
  const tb = payeeTokens(b).kept.join(" ");
  if (ta === tb) return "card-terminal noise (codes, city, long numbers)";
  const cyrA = HAS_CYRILLIC.test(a);
  const cyrB = HAS_CYRILLIC.test(b);
  if (cyrA !== cyrB) return "Latin / Cyrillic transliteration";
  return "spelling variant (transliteration, doubled letters, noise)";
}
