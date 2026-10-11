/**
 * lib/transactions/tag-ops.ts — S2 additions: business/personal split,
 * the "/" tree (distinct-transaction rollups), prefix rename and spelling
 * normalization. Pure.
 */
import { describe, it, expect } from "vitest";
import {
  buildTagTree,
  planNormalizeSpelling,
  planPrefixRename,
  renamePrefixTransform,
  summarizeTags,
  tagPathKey,
  type TaggedRow,
  type TagScan,
} from "@/lib/transactions/tag-ops";

const row = (id: number, tags: string, isBusiness = false, amount = -10): TaggedRow => ({
  id, date: "2026-01-01", tags, amount, currency: "CAD", reportingAmount: null, reportingCurrency: null, isBusiness,
});
const scanOf = (rows: TaggedRow[], truncated = false): TagScan => ({ rows, scanned: rows.length, truncated, undecryptable: 0 });

describe("business / personal counts", () => {
  it("splits count by is_business (missing = personal)", () => {
    const out = summarizeTags([row(1, "work", true), row(2, "work"), row(3, "work", true)]);
    expect(out[0]).toMatchObject({ count: 3, businessCount: 2, personalCount: 1 });
  });
});

describe("buildTagTree", () => {
  const rows = [
    row(1, "команда/Іваненко,команда/Петренко", true, -10), // two tags of one branch on one row
    row(2, "команда/Іваненко", false, -5),
    row(3, "команда", false, -1),
    row(4, "trip", false, -2),
    row(5, "команда / іваненко/обід", false, -3),
  ];
  const tree = buildTagTree(rows);
  const byKey = new Map(tree.map((n) => [n.key, n]));

  it("rolls up DISTINCT transactions per prefix (no double counting)", () => {
    const root = byKey.get("команда")!;
    expect(root.count).toBe(4); // rows 1, 2, 3, 5 — row 1 once despite two child tags
    expect(root.ownCount).toBe(1);
    expect(root.isTag).toBe(true);
    expect(root.businessCount).toBe(1);
    expect(root.personalCount).toBe(3);
    expect(root.childCount).toBe(2);
    expect(root.tagCount).toBe(4); // команда, команда/іваненко, команда/петренко, команда/іваненко/обід
    expect(root.slices[0].totalAmount).toBe(-19);
  });

  it("children carry parentKey, depth and their own rollup", () => {
    const sh = byKey.get("команда/іваненко")!;
    expect(sh).toMatchObject({ depth: 1, parentKey: "команда", count: 3, ownCount: 2, name: "Іваненко", path: "команда/Іваненко" });
    expect(byKey.get("команда/іваненко/обід")).toMatchObject({ depth: 2, count: 1, isTag: true });
  });

  it("plain tags are depth-0 leaves", () => {
    expect(byKey.get("trip")).toMatchObject({ depth: 0, parentKey: null, childCount: 0, count: 1 });
  });

  it("tagPathKey trims segments and normalizes each", () => {
    expect(tagPathKey(" Команда / Іваненко ")).toBe("команда/іваненко");
  });
});

describe("prefix rename", () => {
  it("renames the prefix itself and every tag under it, leaving others", () => {
    const t = renamePrefixTransform("команда", "друзі");
    expect(t("команда/Іваненко,trip,команда")).toBe("друзі/Іваненко,trip,друзі");
    expect(t("командаX,trip")).toBe("командаX,trip"); // not a path boundary
    expect(t("Команда / Петренко / обід")).toBe("друзі/Петренко/обід");
  });

  it("previews tags, transactions and collisions", () => {
    const scan = scanOf([row(1, "команда/Іваненко"), row(2, "команда/Петренко,trip"), row(3, "друзі/Іваненко"), row(4, "trip")]);
    const r = planPrefixRename("команда", "друзі", scan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({ affected: 2, tagCount: 2, collisions: ["друзі/іваненко"], tooLarge: false });
    expect(r.plan.ids).toEqual([1, 2]);
  });

  it("refuses empty, comma and into-itself targets", () => {
    const scan = scanOf([row(1, "a/b")]);
    expect(planPrefixRename("a", "", scan).ok).toBe(false);
    expect(planPrefixRename("a", "x,y", scan).ok).toBe(false);
    expect(planPrefixRename("a", "a/c", scan).ok).toBe(false);
  });
});

describe("normalize spelling", () => {
  const scan = scanOf([
    row(1, "Acme"),
    row(2, "Acme,trip"),
    row(3, "acme "),
    row(4, "Trip"),
    row(5, "trip"),
    row(6, "trip"),
  ]);

  it("rewrites every variant to the most used spelling", () => {
    const { plan, transform } = planNormalizeSpelling(scan);
    expect(plan.tags).toEqual([
      { tag: "trip", variants: ["Trip"] },
      { tag: "Acme", variants: ["acme"] },
    ]);
    expect(plan.ids).toEqual([3, 4]);
    expect(transform("acme ")).toBe("Acme");
    expect(transform("Trip,x")).toBe("trip,x");
  });

  it("can be limited to some tags", () => {
    const { plan } = planNormalizeSpelling(scan, ["ACME"]);
    expect(plan.tags.map((t) => t.tag)).toEqual(["Acme"]);
    expect(plan.ids).toEqual([3]);
  });
});
