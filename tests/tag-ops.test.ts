/**
 * lib/transactions/tag-ops.ts — the pure parts: summarizeTags, normalizeTagOp,
 * planTagOp, tagOpTransform.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeTagOp,
  planTagOp,
  summarizeTags,
  tagOpTransform,
  TAG_OP_MAX_ROWS,
  type TagOp,
  type TaggedRow,
  type TagScan,
} from "@/lib/transactions/tag-ops";

const row = (id: number, tags: string, date = "2026-01-01", amount = -10, currency = "CAD"): TaggedRow => ({
  id, date, tags, amount, currency, reportingAmount: null, reportingCurrency: null,
});
const scanOf = (rows: TaggedRow[], truncated = false): TagScan => ({ rows, scanned: rows.length, truncated, undecryptable: 0 });

describe("summarizeTags", () => {
  const rows = [
    row(1, "acme ,travel", "2026-03-01", -5),
    row(2, "Acme", "2026-01-15", -7, "USD"),
    row(3, "Acme, ACME", "2026-02-01", -1),
    row(4, "travel", "2025-12-31", 100),
  ];
  const out = summarizeTags(rows);
  const ac = out.find((t) => t.key === "acme")!;

  it("one entry per normalized tag, sorted by count", () => {
    expect(out.map((t) => [t.tag, t.count])).toEqual([["Acme", 3], ["travel", 2]]);
  });

  it("shown spelling = most used; variants are flagged with their counts", () => {
    expect(ac.tag).toBe("Acme");
    expect(ac.hasVariants).toBe(true);
    expect(ac.spellings).toEqual([
      { spelling: "Acme", count: 2 },
      { spelling: "acme", count: 1 },
      { spelling: "ACME", count: 1 },
    ]);
    expect(out.find((t) => t.key === "travel")!.hasVariants).toBe(false);
  });

  it("ties go to the spelling seen first", () => {
    const [t] = summarizeTags([row(1, "Lviv"), row(2, "lviv")]);
    expect(t.tag).toBe("Lviv");
  });

  it("first / last date and per-currency sums", () => {
    expect(ac.firstDate).toBe("2026-01-15");
    expect(ac.lastDate).toBe("2026-03-01");
    expect(ac.slices).toEqual(
      expect.arrayContaining([
        { currency: "CAD", reportingCurrency: null, totalAmount: -6, totalReporting: null },
        { currency: "USD", reportingCurrency: null, totalAmount: -7, totalReporting: null },
      ]),
    );
  });

  it("empty input → no tags", () => {
    expect(summarizeTags([row(1, " , ")])).toEqual([]);
  });
});

describe("normalizeTagOp", () => {
  it.each<[TagOp, RegExp]>([
    [{ op: "rename", from: "a", to: "" }, /new tag name/],
    [{ op: "rename", from: "a", to: "b,c" }, /new tag name/],
    [{ op: "rename", from: " ", to: "b" }, /rename/i],
    [{ op: "merge", from: [], to: "b" }, /merge/],
    [{ op: "delete", tags: [" , "] }, /delete/],
  ])("%j is refused", (op, msg) => {
    const r = normalizeTagOp(op);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });

  it("trims and dedupes", () => {
    expect(normalizeTagOp({ op: "merge", from: ["a ", "A", "b"], to: " c " })).toEqual({ ok: true, op: { op: "merge", from: ["a", "b"], to: "c" } });
  });
});

describe("planTagOp / tagOpTransform", () => {
  const scan = scanOf([
    row(1, "ac,x"),
    row(2, "Acme"),
    row(3, "x,ac,Acme"),
    row(4, "work"),
    row(5, "homework"),
  ]);

  it("rename to a new name changes only rows with the tag", () => {
    const p = planTagOp({ op: "rename", from: "WORK", to: "Job" }, scan);
    expect(p.ids).toEqual([4]);
    expect(p.targetExists).toBe(false);
    expect(tagOpTransform({ op: "rename", from: "work", to: "Job" })("homework,work")).toBe("homework,Job");
  });

  it("rename onto an existing tag is a merge", () => {
    const p = planTagOp({ op: "rename", from: "ac", to: "Acme" }, scan);
    expect(p.ids).toEqual([1, 3]);
    expect(p.targetExists).toBe(true);
    expect(p.targetCount).toBe(2);
    const t = tagOpTransform({ op: "rename", from: "ac", to: "Acme" });
    expect(t("x,ac,Acme")).toBe("x,Acme");
    expect(t("ac,x")).toBe("Acme,x");
  });

  it("a respelling of the same tag is not reported as a merge", () => {
    const p = planTagOp({ op: "rename", from: "acme", to: "ACME" }, scan);
    expect(p.targetExists).toBe(false);
    expect(p.ids).toEqual([2, 3]);
  });

  it("merge several into one", () => {
    const p = planTagOp({ op: "merge", from: ["ac", "work"], to: "Acme" }, scan);
    expect(p.ids).toEqual([1, 3, 4]);
    expect(p.targetExists).toBe(true);
  });

  it("delete removes the tag only (work ≠ homework)", () => {
    const p = planTagOp({ op: "delete", tags: ["work"] }, scan);
    expect(p.ids).toEqual([4]);
    expect(tagOpTransform({ op: "delete", tags: ["work"] })("work")).toBe("");
  });

  it("over the row limit or a truncated scan is flagged", () => {
    const big = scanOf(Array.from({ length: TAG_OP_MAX_ROWS + 1 }, (_, i) => row(i + 1, "t")));
    expect(planTagOp({ op: "delete", tags: ["t"] }, big).tooLarge).toBe(true);
    expect(planTagOp({ op: "delete", tags: ["work"] }, scanOf(scan.rows, true)).truncated).toBe(true);
  });
});
