/**
 * Payee Studio i18n (P6.2): one uk / en dictionary for every Studio screen.
 *
 * - every key is in both languages, no value is empty;
 * - both languages use the same `{placeholders}`;
 * - `studioT` fills placeholders and falls back to Ukrainian;
 * - the Studio's .tsx files keep no hardcoded UI words in JSX text nodes or
 *   in aria-label / title / placeholder attributes (sample strings that were
 *   moved into the dictionary).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { STUDIO_TEXT, studioT, type StudioTextKey } from "@/lib/payees/i18n";

const uk = STUDIO_TEXT.uk as Record<string, string>;
const en = STUDIO_TEXT.en as Record<string, string>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("Payee Studio dictionary", () => {
  it("has every key in both languages", () => {
    expect(Object.keys(uk).length).toBeGreaterThan(100);
    expect(Object.keys(en).filter((k) => !(k in uk))).toEqual([]);
    expect(Object.keys(uk).filter((k) => !(k in en))).toEqual([]);
  });

  it("has no empty values", () => {
    for (const table of [uk, en]) {
      expect(Object.entries(table).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    }
  });

  it("uses the same placeholders in both languages", () => {
    const mismatched = Object.keys(uk).filter((k) => placeholders(uk[k]).join(",") !== placeholders(en[k] ?? "").join(","));
    expect(mismatched).toEqual([]);
  });

  it("groups keys by screen prefix", () => {
    expect(Object.keys(uk).filter((k) => !/^[a-z]+\.[A-Za-z0-9_.]+$/.test(k))).toEqual([]);
  });

  it("fills placeholders and picks the language", () => {
    expect(studioT("en", "common.rows", { n: 12 })).toBe("12 rows");
    expect(studioT("uk", "common.rows", { n: 12 })).toBe("12 рядк.");
    expect(studioT("en", "common.cancel")).toBe("Cancel");
    expect(studioT("uk", "common.cancel")).toBe("Скасувати");
    expect(studioT("uk", "nope.missing" as StudioTextKey)).toBe("nope.missing");
  });
});

describe("Payee Studio screens have no hardcoded UI text", () => {
  const root = path.join(__dirname, "..", "src", "app", "(app)", "settings", "payees");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx")) files.push(p);
    }
  };
  walk(root);
  const sources = files.map((f) => ({ file: path.relative(root, f), text: fs.readFileSync(f, "utf8") }));

  /** Literal text between JSX tags: `>Cancel<`, `>\n  Loading…\n<`. */
  const textNodes = (src: string) =>
    [...src.matchAll(/>([^<>{}]*)</g)].map((m) => m[1].replace(/\s+/g, " ").trim()).filter(Boolean);

  const SAMPLES = [
    "Loading…",
    "Cancel",
    "Undo",
    "Undone",
    "Merge…",
    "Add to directory",
    "Show transactions",
    "Explain…",
    "Save…",
    "Remove",
    "Edit",
    "Needs decision",
    "Payees",
    "Requisites",
    "Скасувати",
    "Перейменувати",
    "Видалити",
    "Додати",
    "Без типу",
  ];

  it("finds the Studio files", () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(["page.tsx", path.join("_components", "op-dialog.tsx"), path.join("[id]", "page.tsx")]));
  });

  it("has none of the moved sample strings as JSX text", () => {
    const found = sources.flatMap((s) => textNodes(s.text).filter((t) => SAMPLES.includes(t)).map((t) => `${s.file}: ${t}`));
    expect(found).toEqual([]);
  });

  it("has no literal words in aria-label / title / placeholder attributes", () => {
    // The language selector stays bilingual on purpose; codes and examples are not words to translate.
    const allowed = new Set(["Мова Studio / Studio language", "UAH", "example.com"]);
    const found = sources.flatMap((s) =>
      [...s.text.matchAll(/\b(?:aria-label|title|placeholder)="([^"]*)"/g)]
        .map((m) => m[1])
        .filter((v) => /\p{L}/u.test(v) && !allowed.has(v))
        .map((v) => `${s.file}: ${v}`),
    );
    expect(found).toEqual([]);
  });
});
