/**
 * Payee Studio P4 — dictionary export / import and recurrence detection. Pure.
 */
import { describe, it, expect } from "vitest";
import {
  buildDictionary,
  dictionaryToJson,
  dictionaryToYaml,
  parseDictionary,
  parseSimpleYaml,
  planDictionaryImport,
  dictionaryImportOps,
} from "@/lib/payees/dictionary";
import { detectRecurrence } from "@/lib/payees/insights";
import type { PayeeEntity } from "@/lib/payees/directory";

const ent = (id: number, name: string, type: PayeeEntity["type"], aliases: Array<[string, string?, string?]> = [], identifiers: Array<[string, string]> = []): PayeeEntity => ({
  id, name, type, note: "private note", defaultCategoryId: 3, createdAt: null, updatedAt: null,
  aliases: [{ id: id * 100, entityId: id, pattern: name, mode: "exact", source: "canonical", createdAt: null },
    ...aliases.map(([pattern, mode = "exact", source = "manual"], i) => ({ id: id * 100 + i + 1, entityId: id, pattern, mode: mode as "exact", source, createdAt: null }))],
  identifiers: identifiers.map(([kind, value], i) => ({ id: id * 10 + i, entityId: id, kind: kind as "iban", value, createdAt: null })),
});

const directory: PayeeEntity[] = [
  ent(1, "Епіцентр", "retail", [["Epicentr"], ["EPITCENTR K10 KYIV 360616"], ["4149 4393 1234 5678 PAY"]], [["edrpou", "32490244"], ["iban", "UA213223130000026007233566001"], ["card_last4", "5678"]]),
  ent(2, "Деркач Олександр Петрович", "person", [["DERKACH OLEKSANDR PETROVYCH"]], [["tax_id", "1234567890"]]),
  ent(3, "FOP Davydzon", "sole_proprietor"),
  ent(4, "Ощадбанк", "bank", [["OSCHADBANK"], ["Деркач Олександр Петрович переказ"]], [["iban", "UA903052990000026000000000001"]]),
];

describe("dictionary export", () => {
  const d = buildDictionary(directory, new Date("2026-10-11T00:00:00Z"));
  it("keeps only shareable data", () => {
    expect(d.entries.map((e) => e.name)).toEqual(["Епіцентр", "Ощадбанк"]);
    // Dropped aliases: the card-number one, the person one, and the 6-digit terminal id (long digit run).
    expect(d.skipped).toEqual({ people: 2, aliases: 3, identifiers: 2 });
    const epi = d.entries.find((e) => e.name === "Епіцентр")!;
    expect(epi.aliases.map((a) => a.pattern)).toEqual(["Epicentr"]);
    expect(epi.identifiers).toEqual([{ kind: "edrpou", value: "32490244" }]); // retail IBAN + card dropped
    expect(d.entries.find((e) => e.name === "Ощадбанк")!.identifiers[0].kind).toBe("iban"); // bank IBAN kept
    const json = dictionaryToJson(d);
    for (const secret of ["private note", "5678", "1234567890", "Деркач", "Davydzon", "defaultCategoryId"]) expect(json).not.toContain(secret);
  });

  it("round-trips through JSON and YAML", () => {
    const fromJson = parseDictionary(dictionaryToJson(d));
    const yaml = dictionaryToYaml(d);
    expect(yaml).toContain('  - name: "Епіцентр"');
    const fromYaml = parseDictionary(yaml);
    expect(fromYaml).toEqual(fromJson);
    expect(fromJson.entries).toEqual(d.entries);
  });

  it("reads hand-written YAML and reports bad files and entries", () => {
    const yaml = [
      "# my merchants",
      "format: finlynq-payee-dictionary",
      "version: 1",
      "entries:",
      "- name: Colin's",
      "  type: retail",
      "  aliases:",
      "    - Colin’s   # typographic apostrophe",
      "    - pattern: COLINS",
      "      mode: contains",
      "- name: ''",
    ].join("\n");
    const r = parseDictionary(yaml);
    expect(r.entries).toEqual([{ name: "Colin's", type: "retail", aliases: [{ pattern: "Colin’s", mode: "exact" }, { pattern: "COLINS", mode: "contains" }], identifiers: [] }]);
    expect(r.errors[0].index).toBe(1);
    expect(() => parseDictionary('{"format":"something-else","version":1,"entries":[]}')).toThrow(/Not a payee dictionary/);
    expect(() => parseDictionary('{"format":"finlynq-payee-dictionary","version":9,"entries":[]}')).toThrow(/version 9/);
    expect(() => parseSimpleYaml("a: 1\n\tb: 2")).toThrow(/tabs/);
  });
});

describe("dictionary import plan", () => {
  const entries = parseDictionary(dictionaryToJson({
    format: "finlynq-payee-dictionary", version: 1, exportedAt: "",
    entries: [
      { name: "Epicentr", type: "retail", aliases: [{ pattern: "Епіцентр К", mode: "exact" }], identifiers: [{ kind: "edrpou", value: "32490244" }] },
      { name: "Silpo", type: "retail", aliases: [], identifiers: [] },
      { name: "Oschadbank", type: "bank", aliases: [{ pattern: "Epicentr", mode: "exact" }], identifiers: [] },
      { name: "Silpo", type: "retail", aliases: [], identifiers: [] },
    ],
  })).entries;

  it("creates, merges and flags conflicts", () => {
    const plan = planDictionaryImport(entries, directory);
    expect(plan.map((p) => p.action)).toEqual(["merge", "create", "conflict", "conflict"]);
    expect(plan[0].target).toEqual({ id: 1, name: "Епіцентр" });
    expect(plan[0].newAliases).toEqual([{ pattern: "Епіцентр К", mode: "exact" }]); // name key already known; edrpou already there
    expect(plan[0].newIdentifiers).toEqual([]);
    expect(plan[2].candidates.map((c) => c.id).sort()).toEqual([1, 4]);
    expect(plan[3].note).toMatch(/Duplicate of entry #2/);
  });

  it("applies explicit decisions and turns the plan into ops without renaming payees", () => {
    const plan = planDictionaryImport(entries, directory, { 2: "merge:4", 3: "skip" });
    // "Oschadbank" already resolves to Ощадбанк (alias OSCHADBANK) and "Epicentr" stays with Епіцентр: nothing to add.
    expect(plan.map((p) => p.action)).toEqual(["merge", "create", "unchanged", "skip"]);
    const { ops, labels } = dictionaryImportOps(plan);
    expect(ops.map((o) => o.op)).toEqual(["alias_add", "create"]);
    expect(ops.every((o) => !("apply" in o) || o.apply === false)).toBe(true);
    expect(labels[0]).toBe('entry #1 ("Epicentr")');
    expect(planDictionaryImport(entries, directory, { 1: "create" })[1].action).toBe("create");
  });
});

describe("detectRecurrence", () => {
  it("finds monthly and weekly rhythms and ignores irregular or daily ones", () => {
    expect(detectRecurrence(["2026-01-05", "2026-02-05", "2026-03-06", "2026-04-05"])).toMatchObject({ cadence: "monthly", last: "2026-04-05" });
    expect(detectRecurrence(["2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22"])!.cadence).toBe("weekly");
    expect(detectRecurrence(["2026-01-01", "2026-01-03", "2026-03-20", "2026-03-21"])).toBeNull();
    expect(detectRecurrence(["2026-01-01", "2026-01-02", "2026-01-03"])).toBeNull();
    expect(detectRecurrence(["2026-01-01", "2026-02-01"])).toBeNull();
  });
});
