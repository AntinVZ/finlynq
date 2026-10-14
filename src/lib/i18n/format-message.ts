/**
 * A small ICU MessageFormat subset (P8 stage 6), enough for interface texts:
 *
 *   {name}                                  a variable, inserted as is
 *   {n, plural, =0 {…} one {…} few {…} many {…} other {…}}
 *                                           CLDR plural categories through
 *                                           Intl.PluralRules (Ukrainian has
 *                                           one / few / many); `#` inside a
 *                                           branch is `n` formatted for the
 *                                           language
 *
 * An unknown variable is left as `{name}`, so a missing value is visible
 * instead of silently empty. Pure (web and server).
 */
import type { TranslateVars } from "./types";

/** The index of the `}` matching the `{` at `open`, or -1. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** `one {…} other {…}` → { one: "…", other: "…" }. */
export function pluralBranches(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const m = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/.exec(body.slice(i));
    if (!m) break;
    const open = i + m[0].length - 1;
    const end = closing(body, open);
    if (end < 0) break;
    out[m[1]] = body.slice(open + 1, end);
    i = end + 1;
  }
  return out;
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function rulesFor(locale: string): Intl.PluralRules {
  let r = pluralRules.get(locale);
  if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)));
  return r;
}

function numberFor(locale: string): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale)));
  return f;
}

export function formatMessage(template: string, intlLocale: string, vars?: TranslateVars, hash?: string): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === "#" && hash != null) {
      out += hash;
      i++;
      continue;
    }
    if (c !== "{") {
      out += c;
      i++;
      continue;
    }
    const end = closing(template, i);
    if (end < 0) {
      out += template.slice(i);
      break;
    }
    const inner = template.slice(i + 1, end);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
    if (plural) {
      const raw = vars?.[plural[1]];
      const n = typeof raw === "number" ? raw : Number(raw);
      const branches = pluralBranches(plural[2]);
      const pick = Number.isFinite(n)
        ? (branches[`=${n}`] ?? branches[rulesFor(intlLocale).select(n)] ?? branches.other)
        : branches.other;
      out += formatMessage(pick ?? "", intlLocale, vars, Number.isFinite(n) ? numberFor(intlLocale).format(n) : String(raw ?? ""));
    } else {
      const name = inner.trim();
      out += vars && name in vars ? String(vars[name]) : `{${inner}}`;
    }
    i = end + 1;
  }
  return out;
}

/** The variable names a template uses (`{name}` and plural selectors), sorted. */
export function messageVariables(template: string): string[] {
  const names = new Set<string>();
  const walk = (t: string) => {
    let i = 0;
    while (i < t.length) {
      if (t[i] !== "{") {
        i++;
        continue;
      }
      const end = closing(t, i);
      if (end < 0) return;
      const inner = t.slice(i + 1, end);
      const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
      if (plural) {
        names.add(plural[1]);
        for (const b of Object.values(pluralBranches(plural[2]))) walk(b);
      } else names.add(inner.trim());
      i = end + 1;
    }
  };
  walk(template);
  return [...names].sort();
}
