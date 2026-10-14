/**
 * Payee Studio P6.2 stage 2 (pure): the "Перевірити" rules — a short name, a
 * name with no letters, one or two Latin words with no brand sign — and the
 * brand signs that keep a real brand out of the list.
 */
import { describe, it, expect } from "vitest";
import { hasBrandSigns, listSuspicious, suspiciousReasons } from "@/lib/payees/suspicious";
import type { PayeeEntity } from "@/lib/payees/directory";

const codes = (name: string, brandSigns = false) => suspiciousReasons(name, { brandSigns }).map((r) => r.code);

describe("suspicious names", () => {
  it.each([
    ["Ma", ["short"]],
    ["Galia baluvana", ["latin_no_brand"]],
    ["12345", ["no_letters"]],
    ["--", ["no_letters"]],
    ["Zbs", ["short"]],
    ["ATB", ["short"]], // three letters: listed until it has a merchant type or is marked checked
  ])("%s → %j", (name, expected) => {
    expect(codes(name)).toEqual(expected);
  });

  it.each(["Сільпо", "Епіцентр", "PlayStation Network", "OKKO", "WOG Plus", "Netflix.com", "Store 24", "Bar Pesto", "ТОВ Рога", "Нова Пошта", "Glovo Kyiv Ukraine Delivery"])("%s is not suspicious", (name) => {
    expect(codes(name)).toEqual([]);
  });

  it("the fragment reason for a two-word lower-case tail", () => {
    expect(suspiciousReasons("Galia baluvana")[0].reason).toContain("fragment");
    expect(suspiciousReasons("Netflix")[0].reason).toContain("single Latin word");
  });

  it("brand signs (type, website, requisites, two confirmed spellings) keep an entry out", () => {
    expect(codes("Netflix", true)).toEqual([]);
    expect(codes("KFC", true)).toEqual([]);
    expect(codes("12", true)).toEqual(["no_letters"]);
    const base: PayeeEntity = { id: 1, name: "Netflix", type: "service", note: null, defaultCategoryId: null, website: null, logo: null, merchantTypeId: null, createdAt: null, updatedAt: null, aliases: [], identifiers: [] };
    expect(hasBrandSigns(base)).toBe(false);
    expect(hasBrandSigns({ ...base, merchantTypeId: 3 })).toBe(true);
    expect(hasBrandSigns({ ...base, website: "https://netflix.com" })).toBe(true);
  });

  it("checked entries are left out unless asked; most rows first", () => {
    const e = (id: number, name: string, reviewedAt: string | null = null): PayeeEntity => ({ id, name, type: "other", note: null, defaultCategoryId: null, website: null, logo: null, merchantTypeId: null, reviewedAt, createdAt: null, updatedAt: null, aliases: [], identifiers: [] });
    const dir = [e(1, "Ma"), e(2, "Galia baluvana"), e(3, "Сільпо"), e(4, "Xy", "2026-10-01T00:00:00Z")];
    const rows = (id: number) => ({ count: id * 10, spellings: [] });
    expect(listSuspicious(dir, rows).map((x) => x.name)).toEqual(["Galia baluvana", "Ma"]);
    expect(listSuspicious(dir, rows, { includeReviewed: true }).map((x) => x.name)).toEqual(["Xy", "Galia baluvana", "Ma"]);
  });
});
