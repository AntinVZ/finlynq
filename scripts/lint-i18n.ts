/**
 * i18n check (P8 stage 6), run by `npm run lint:i18n` and by
 * tests/i18n-locales.test.ts:
 *
 *  - every language has exactly the English keys, none empty;
 *  - every translation uses the same variables (and plural selectors) as English,
 *    and every plural has an `other` branch;
 *  - every key is used somewhere in the code (as a string literal), except
 *    keys under a DYNAMIC prefix (built at run time, e.g. `mtype.${code}`).
 */
import fs from "fs";
import path from "path";
import * as en from "../src/lib/i18n/locales/en";
import * as uk from "../src/lib/i18n/locales/uk";
import { messageVariables, pluralBranches } from "../src/lib/i18n/format-message";

/** Keys built at run time; each prefix must be documented where it is built. */
export const DYNAMIC_KEY_PREFIXES = ["mtype.", "mtypeGroup."];

const LANGUAGES: Record<string, Record<string, string>> = { en: en.messages, uk: uk.messages };

export type I18nProblem = { kind: "missing" | "extra" | "empty" | "variables" | "plural" | "unused"; lang?: string; key: string; detail?: string };

function pluralsWithoutOther(template: string): boolean {
  const re = /\{\s*\w+\s*,\s*plural\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    // the plural body runs to the matching brace
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < template.length; i++) {
      if (template[i] === "{") depth++;
      else if (template[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = template.slice(m.index + m[0].length, end);
    if (!("other" in pluralBranches(body))) return true;
  }
  return false;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|mjs)$/.test(e.name) && !p.includes(`${path.sep}i18n${path.sep}locales${path.sep}`)) out.push(p);
    }
  };
  walk(root);
  return out;
}

export function checkI18n(repoRoot = path.join(__dirname, "..")): I18nProblem[] {
  const problems: I18nProblem[] = [];
  const master = LANGUAGES.en;
  const keys = Object.keys(master);
  for (const [lang, table] of Object.entries(LANGUAGES)) {
    for (const k of keys) {
      if (!(k in table)) problems.push({ kind: "missing", lang, key: k });
      else if (!table[k].trim()) problems.push({ kind: "empty", lang, key: k });
      else {
        const a = messageVariables(master[k]).join(",");
        const b = messageVariables(table[k]).join(",");
        if (a !== b) problems.push({ kind: "variables", lang, key: k, detail: `en {${a}} vs ${lang} {${b}}` });
        if (pluralsWithoutOther(table[k])) problems.push({ kind: "plural", lang, key: k, detail: "a plural without `other`" });
      }
    }
    for (const k of Object.keys(table)) if (!(k in master)) problems.push({ kind: "extra", lang, key: k });
  }
  const code = [...sourceFiles(path.join(repoRoot, "src")), ...sourceFiles(path.join(repoRoot, "mcp-server"))].map((f) => fs.readFileSync(f, "utf8")).join("\n");
  for (const k of keys) {
    if (DYNAMIC_KEY_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (!code.includes(`"${k}"`) && !code.includes(`'${k}'`) && !code.includes(`\`${k}\``)) problems.push({ kind: "unused", key: k });
  }
  return problems;
}

if (require.main === module) {
  const problems = checkI18n();
  for (const p of problems) console.log(`${p.kind}${p.lang ? ` [${p.lang}]` : ""}: ${p.key}${p.detail ? ` — ${p.detail}` : ""}`);
  console.log(problems.length ? `\n${problems.length} i18n problem(s).` : "i18n: OK");
  process.exit(problems.length ? 1 : 0);
}
