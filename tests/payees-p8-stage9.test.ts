/**
 * P8 stage 9 (pure parts): Cyrillic word boundaries in the payee type guess
 * (B31), the activity log treats merchant_types / coverage / queue as reads
 * (B32), cursor paging for the large MCP answers (B7) and which AI drafts
 * "Select ≥ threshold" may pick.
 */
import { describe, it, expect } from "vitest";
import { guessPayeeType } from "@/lib/payees/match-key";
import { isWriteCall } from "@/lib/mcp/activity-log";
import { decodeCursor, encodeCursor, pageOf, pageMeta } from "@/lib/payees/mcp-page";
import { eligibleDrafts, type Proposal } from "@/app/(app)/merchants/_components/ai-drafts-panel";
import { proposalException } from "@/lib/payees/proposals";

describe("B31: Cyrillic words are whole words", () => {
  it("finds a Cyrillic company form, bank, tax office and shop word", () => {
    expect(guessPayeeType("ТОВ Будмайстер").type).toBe("company");
    expect(guessPayeeType("АТ Укргазвидобування").type).toBe("company");
    expect(guessPayeeType("ДПС у м. Києві").type).toBe("government");
    expect(guessPayeeType("Банк Восток").type).toBe("bank");
    expect(guessPayeeType("Шоп Дім").type).toBe("retail");
  });
  it("does not match inside a longer word", () => {
    expect(guessPayeeType("Товари для дому").type).not.toBe("company");
    expect(guessPayeeType("Атлантида").type).not.toBe("company");
    expect(guessPayeeType("Банкет-зал").type).not.toBe("bank");
  });
});

describe("B30: every type word gives a type guess", () => {
  it("АЗС, a hotel and a café are places of business, not «other»", () => {
    for (const p of ["AZS OKKO", "АЗС WOG", "Готель Дніпро", "Hotel Rus", "Кав'ярня Світ"]) expect(guessPayeeType(p).type).toBe("retail");
    expect(guessPayeeType("AZS OKKO").reason).toMatch(/azs|азс/i);
    expect(guessPayeeType("Zxqwv").type).toBe("other");
  });
});

describe("B32: Studio reads are not writes", () => {
  it("merchant_types, coverage and queue are reads; merchant_types_edit is a write", () => {
    expect(isWriteCall("manage_payees", "merchant_types")).toBe(false);
    expect(isWriteCall("manage_payees", "coverage")).toBe(false);
    expect(isWriteCall("manage_payees", "queue")).toBe(false);
    expect(isWriteCall("manage_payees", "merchant_types_edit")).toBe(true);
  });
});

describe("B7: cursor paging", () => {
  const rows = Array.from({ length: 7 }, (_, i) => i);
  it("pages with next_cursor until the last page", () => {
    const p1 = pageOf(rows, { limit: 3 });
    expect(p1).toMatchObject({ items: [0, 1, 2], total: 7, truncated: true });
    const p2 = pageOf(rows, { limit: 3, cursor: p1.next_cursor });
    expect(p2.items).toEqual([3, 4, 5]);
    const p3 = pageOf(rows, { limit: 3, cursor: p2.next_cursor });
    expect(p3).toMatchObject({ items: [6], truncated: false });
    expect(p3.next_cursor).toBeUndefined();
    expect(pageMeta(p3)).toEqual({ total: 7, truncated: false });
  });
  it("a foreign or broken cursor starts from the top", () => {
    expect(decodeCursor("garbage!!")).toBe(0);
    expect(decodeCursor(Buffer.from("x:5").toString("base64url"))).toBe(0);
    expect(decodeCursor(encodeCursor(4))).toBe(4);
    expect(pageOf(rows, { limit: 2, cursor: encodeCursor(100) })).toMatchObject({ items: [], truncated: false });
  });
});

describe("AI drafts: accept above a threshold, with exceptions", () => {
  const base: Omit<Proposal, "id" | "confidence" | "needsDecision" | "notes"> = { canonical: "X", type: "merchant", entityId: null, aliases: [], identifiers: [], reason: "", status: "draft", createdAt: "" };
  const list: Proposal[] = [
    { ...base, id: 1, confidence: 0.95, needsDecision: false, notes: [] },
    { ...base, id: 2, confidence: 0.97, needsDecision: true, notes: [] },
    { ...base, id: 3, confidence: 0.99, needsDecision: false, notes: ["conflict"] },
    { ...base, id: 4, confidence: 0.7, needsDecision: false, notes: [] },
    { ...base, id: 5, confidence: 0.99, needsDecision: false, notes: [], exception: "type_word" },
  ];
  it("picks confident drafts only, never a person or a draft with a warning", () => {
    expect(eligibleDrafts(list, 90).map((p) => p.id)).toEqual([1]);
    expect(eligibleDrafts(list, 60).map((p) => p.id)).toEqual([1, 4]);
  });
  it("a name of type words only or a bare channel is an exception", () => {
    expect(proposalException("Аптека")).toBe("type_word");
    expect(proposalException("P24")).toBe("channel");
    expect(proposalException("Аптека Доброго Дня")).toBeUndefined();
    expect(proposalException("Епіцентр")).toBeUndefined();
  });
});
