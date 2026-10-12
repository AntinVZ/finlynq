/**
 * Payee Studio P5c (pure): website normalization and logo validation.
 */
import { describe, it, expect } from "vitest";
import { decodeLogo, LOGO_MAX_BYTES, normalizeLogo, normalizeWebsite } from "@/lib/payees/profile";
import { buildDictionary, parseDictionary, planDictionaryImport } from "@/lib/payees/dictionary";
import type { PayeeEntity } from "@/lib/payees/directory";
import { PNG_1PX } from "./helpers/payee-fixtures";


describe("normalizeWebsite", () => {
  it("forces https, lower-cases the host, drops query / fragment / credentials / port", () => {
    expect(normalizeWebsite("epicentrk.ua")).toBe("https://epicentrk.ua");
    expect(normalizeWebsite("http://WWW.Epicentrk.UA/shop/?utm=x#top")).toBe("https://www.epicentrk.ua/shop");
    expect(normalizeWebsite("https://user:pw@silpo.ua:8443/a/b/")).toBe("https://silpo.ua/a/b");
  });
  it("refuses anything but a public http(s) site", () => {
    expect(() => normalizeWebsite("javascript:alert(1)")).toThrow(/http and https/);
    expect(() => normalizeWebsite("ftp://files.example.com")).toThrow(/http and https/);
    expect(() => normalizeWebsite("data:text/html,hi")).toThrow(/http and https/);
    expect(() => normalizeWebsite("http://192.168.0.1")).toThrow(/public/);
    expect(() => normalizeWebsite("localhost")).toThrow(/public/);
    expect(() => normalizeWebsite("")).toThrow();
  });
});

describe("normalizeLogo", () => {
  it("accepts a real PNG and canonicalizes the data URI", () => {
    const out = normalizeLogo(`data:image/png;base64,${PNG_1PX}`);
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
    expect(decodeLogo(out)?.type).toBe("image/png");
  });
  it("refuses SVG, a lying type, a non-image and anything over 20 KB", () => {
    expect(() => normalizeLogo(`data:image/svg+xml;base64,${Buffer.from("<svg onload='x'/>").toString("base64")}`)).toThrow(/SVG/);
    expect(() => normalizeLogo(`data:image/jpeg;base64,${PNG_1PX}`)).toThrow(/says image\/jpeg but the file is image\/png/);
    expect(() => normalizeLogo(`data:image/png;base64,${Buffer.from("hello world").toString("base64")}`)).toThrow(/not a PNG/);
    const big = Buffer.concat([Buffer.from(PNG_1PX, "base64"), Buffer.alloc(LOGO_MAX_BYTES)]);
    expect(() => normalizeLogo(`data:image/png;base64,${big.toString("base64")}`)).toThrow(/too large/);
    expect(() => normalizeLogo("https://example.com/logo.png")).toThrow(/data: URI/);
  });
});

describe("dictionary carries websites, never logos", () => {
  const e = (id: number, name: string, type: PayeeEntity["type"], website: string | null): PayeeEntity => ({
    id, name, type, note: null, defaultCategoryId: null, website, logo: website ? `data:image/png;base64,${PNG_1PX}` : null, createdAt: null, updatedAt: null,
    aliases: [{ id: id * 10, entityId: id, pattern: name, mode: "exact", source: "canonical", createdAt: null }], identifiers: [],
  });
  it("exports the website of merchants, no logo, no people", () => {
    const d = buildDictionary([e(1, "Епіцентр", "retail", "https://epicentrk.ua"), e(2, "Деркач Олександр Петрович", "person", "https://derkach.me")]);
    expect(d.entries).toEqual([{ name: "Епіцентр", type: "retail", aliases: [], identifiers: [], website: "https://epicentrk.ua" }]);
    expect(JSON.stringify(d)).not.toContain("base64");
  });
  it("imports a website onto an entry that has none", () => {
    const parsed = parseDictionary(JSON.stringify({ format: "finlynq-payee-dictionary", version: 1, entries: [{ name: "Епіцентр", type: "retail", website: "http://epicentrk.ua/" }, { name: "Silpo", website: "silpo.ua" }] }));
    expect(parsed.errors).toEqual([]);
    const plan = planDictionaryImport(parsed.entries, [e(1, "Епіцентр", "retail", null)]);
    expect(plan[0]).toMatchObject({ action: "merge", newWebsite: "https://epicentrk.ua" });
    expect(plan[1]).toMatchObject({ action: "create", newWebsite: "https://silpo.ua" });
    expect(planDictionaryImport(parsed.entries, [e(1, "Епіцентр", "retail", "https://old.ua")])[0]).toMatchObject({ action: "unchanged", newWebsite: null });
  });
});
