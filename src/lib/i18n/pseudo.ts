/**
 * Pseudo locales (P8 stage 6), generated from English for layout checks:
 *
 *   en-XA  accented and ~40% longer, in brackets: truncation, hardcoded
 *          text (it stays plain) and concatenation show at a glance
 *   ar-XB  English inside right-to-left marks with `dir="rtl"`: anything
 *          that does not mirror (left/right instead of start/end) shows
 *
 * Only literal text is changed: `{variables}`, plural selectors and `#`
 * stay intact.
 */
import type { Messages } from "./types";

const ACCENTS: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ö", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Å", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ",
  N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** Apply `fn` to the literal text of a template (brace depth 0, and plural branch bodies). */
function mapLiteral(template: string, fn: (text: string) => string): string {
  let out = "";
  let depth = 0;
  let buf = "";
  const flush = () => {
    if (buf) out += depth % 2 === 0 ? fn(buf) : buf;
    buf = "";
  };
  for (const c of template) {
    if (c === "{" || c === "}") {
      flush();
      out += c;
      depth += c === "{" ? 1 : -1;
    } else if (c === "#" && depth % 2 === 0 && depth > 0) {
      flush();
      out += c;
    } else buf += c;
  }
  flush();
  return out;
}

const mapAll = (m: Messages, fn: (s: string) => string): Messages =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fn(v)])) as Messages;

export function pseudoLong(m: Messages): Messages {
  return mapAll(m, (v) => {
    const accented = mapLiteral(v, (t) => [...t].map((c) => ACCENTS[c] ?? c).join(""));
    const pad = "·".repeat(Math.max(1, Math.round(v.length * 0.4)));
    return `[${accented} ${pad}]`;
  });
}

export function pseudoRtl(m: Messages): Messages {
  return mapAll(m, (v) => `‫${v}‬`);
}
