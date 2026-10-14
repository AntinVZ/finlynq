/**
 * Payee Studio P2 against a real Postgres: directory ops, apply across
 * transactions / recurring / staged, the batch journal and its undo.
 * SKIPS unless DATABASE_URL names a `*_test` database.
 *
 * Run: DATABASE_URL=postgres://…/finlynq_test npx vitest run tests/payees-directory-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";
import { decryptField, encryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Rows<T> = { rows: T[] };

describeDb("Payee Studio P2 directory (seeded DB)", () => {
  let seed: SeededPayees;
  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches RESTART IDENTITY CASCADE`);
    seed = await seedPayeeLedger();
  });

  const op = async (o: unknown, dryRun = false) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, op: o as any, actor: "web", dryRun });
  };
  const txPayees = async () => {
    const { db } = await import("@/db");
    const r = (await db.execute(sql`SELECT payee, import_hash FROM transactions WHERE user_id = ${seed.userId} ORDER BY id`)) as unknown as Rows<{ payee: string; import_hash: string }>;
    return r.rows.map((x) => ({ payee: decryptField(TEST_DEK, x.payee), hash: x.import_hash }));
  };
  const count = (list: Array<{ payee: string | null }>, p: string) => list.filter((x) => x.payee === p).length;

  it("previews without writing, then creates an entity and renames its spellings everywhere but the bank ledger", async () => {
    const { db } = await import("@/db");
    const before = await txPayees();
    const preview = await op({ op: "create", name: "Епіцентр", type: "retail" }, true);
    expect(preview.dryRun).toBe(true);
    expect(preview.rows.byTable).toEqual({ transactions: 8, recurring: 1, staged: 1 });
    expect(preview.rows.changes.map((c) => c.from).sort()).toEqual(["EPITCENTR K10 KYIV 360616", "Epicentr"]);
    const nothing = (await db.execute(sql`SELECT count(*)::int AS n FROM payee_entities`)) as unknown as Rows<{ n: number }>;
    expect(nothing.rows[0].n).toBe(0);
    expect(await txPayees()).toEqual(before);

    const res = await op({ op: "create", name: "Епіцентр", type: "retail" });
    expect(res.batchId).toBeGreaterThan(0);
    expect(res.rows.total).toBe(10);
    const after = await txPayees();
    expect(count(after, "Епіцентр")).toBe(28);
    expect(count(after, "Епіцентр К")).toBe(2); // only look-alike: not an alias
    expect(after.map((x) => x.hash)).toEqual(before.map((x) => x.hash)); // import_hash never recomputed

    const staged = (await db.execute(sql`SELECT payee, encryption_tier FROM staged_transactions WHERE user_id = ${seed.userId}`)) as unknown as Rows<{ payee: string; encryption_tier: string }>;
    expect(staged.rows.every((r) => r.encryption_tier === "service" && r.payee.startsWith("sv1:"))).toBe(true);
    expect(staged.rows.map((r) => decryptStaged(r.payee)).sort()).toEqual(["ATB MARKET", "Епіцентр"]);
    const bank = (await db.execute(sql`SELECT payee FROM bank_transactions WHERE user_id = ${seed.userId}`)) as unknown as Rows<{ payee: string }>;
    expect(decryptField(TEST_DEK, bank.rows[0].payee)).toBe("Епіцентр");
    const rec = (await db.execute(sql`SELECT payee FROM recurring_transactions WHERE user_id = ${seed.userId}`)) as unknown as Rows<{ payee: string }>;
    expect(decryptField(TEST_DEK, rec.rows[0].payee)).toBe("Епіцентр");

    // Stored encrypted; the summary carries counts only.
    const ent = (await db.execute(sql`SELECT name FROM payee_entities`)) as unknown as Rows<{ name: string }>;
    expect(ent.rows[0].name.startsWith("v1:")).toBe(true);
    const batch = (await db.execute(sql`SELECT summary::text AS s, undo_data FROM payee_batches`)) as unknown as Rows<{ s: string; undo_data: string }>;
    expect(batch.rows[0].s).not.toMatch(/Епіцентр|Epicentr/);
    expect(batch.rows[0].undo_data.startsWith("v1:")).toBe(true);
  });

  it("undoes a batch, restoring the original spellings and the directory", async () => {
    const before = await txPayees();
    const res = await op({ op: "create", name: "Епіцентр", type: "retail" });
    const undo = await op({ op: "undo", batchId: res.batchId });
    expect(undo.undo).toMatchObject({ restoredRows: 10, skippedRows: 0, removedEntities: 1 });
    expect(await txPayees()).toEqual(before);
    const { db } = await import("@/db");
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM payee_entities`)) as unknown as Rows<{ n: number }>;
    expect(n.rows[0].n).toBe(0);
    await expect(op({ op: "undo", batchId: res.batchId })).rejects.toThrow(/already undone/);
  });

  it("merges a look-alike into an entity, refuses an out-of-order undo, and leaves rows edited since alone", async () => {
    const { db } = await import("@/db");
    const created = await op({ op: "create", name: "Епіцентр", type: "retail" });
    const merged = await op({ op: "merge", into: { entityId: created.entity!.id }, payees: ["Епіцентр К"] });
    expect(merged.aliasesAdded).toEqual([{ pattern: "Епіцентр К", mode: "exact" }]);
    expect(merged.rows.byTable.transactions).toBe(2);
    expect(count(await txPayees(), "Епіцентр")).toBe(30);

    await expect(op({ op: "undo", batchId: created.batchId })).rejects.toThrow(/newer change/);

    // A user edits one merged row by hand; undoing the merge leaves it alone.
    const target = (await db.execute(sql`SELECT id FROM transactions WHERE user_id = ${seed.userId} ORDER BY id DESC LIMIT 1`)) as unknown as Rows<{ id: number }>;
    await db.execute(sql`UPDATE transactions SET payee = ${encryptField(TEST_DEK, "Hand edited")} WHERE id = ${target.rows[0].id}`);
    const undo = await op({ op: "undo", batchId: merged.batchId });
    expect(undo.undo!.skippedRows).toBeLessThanOrEqual(1);
    expect(undo.undo!.restoredRows + undo.undo!.skippedRows).toBe(2);
    const dir = await (await import("@/lib/payees/directory")).loadDirectory(db, seed.userId, TEST_DEK);
    expect(dir[0].aliases.map((a) => a.pattern)).toEqual(["Епіцентр"]);
    // Now the create can be undone too.
    await op({ op: "undo", batchId: created.batchId });
  });

  it("merges two entities into a new one; aliases and identifiers move, duplicates collapse", async () => {
    const a = await op({ op: "create", name: "Атб Маркет", apply: false, identifiers: [{ kind: "edrpou", value: "30487219" }] });
    const b = await op({ op: "create", name: "АТБ", apply: false, identifiers: [{ kind: "edrpou", value: "30487219" }] });
    const m = await op({ op: "merge", into: { name: "ATB", type: "retail" }, entityIds: [a.entity!.id, b.entity!.id] }, true);
    expect(m.entitiesRemoved).toBe(2);
    expect(m.rows.byTable.transactions).toBe(10); // Атб Маркет ×6 + ATB MARKET ×4
    const real = await op({ op: "merge", into: { name: "ATB", type: "retail" }, entityIds: [a.entity!.id, b.entity!.id] });
    const { db } = await import("@/db");
    const dir = await (await import("@/lib/payees/directory")).loadDirectory(db, seed.userId, TEST_DEK);
    expect(dir).toHaveLength(1);
    expect(dir[0].name).toBe("ATB");
    expect(dir[0].identifiers).toHaveLength(1);
    // P6: "АТБ" and the new canonical "ATB" share a matching key but are different
    // spellings — both stay listed (only the same spelling collapses).
    expect(dir[0].aliases.map((x) => x.pattern).sort()).toEqual(["ATB", "АТБ", "Атб Маркет"].sort());
    expect(real.entity!.name).toBe("ATB");
  });

  it("refuses an exact alias owned by another entity and warns when a person is merged with a merchant", async () => {
    const a = await op({ op: "create", name: "Колінс", apply: false, aliases: [{ pattern: "Colin's" }] });
    const b = await op({ op: "create", name: "Bulochka", apply: false });
    await expect(op({ op: "alias_add", entityId: b.entity!.id, aliases: [{ pattern: "Colin’s" }] })).rejects.toThrow(/already belongs to "Колінс"/);
    const p = await op({ op: "merge", into: { entityId: a.entity!.id }, payees: ["Деркач Олександр Петрович"] }, true);
    expect(p.warnings.join(" ")).toMatch(/private person/);
  });

  it("stores only the last 4 card digits, refuses a full card number and validates identifiers", async () => {
    const { db } = await import("@/db");
    // P6.2: a full card number is refused, never cut down to its last 4 digits.
    await expect(
      op({ op: "create", name: "FOP Davydzon", type: "sole_proprietor", apply: false, identifiers: [{ kind: "card_last4", value: "4149 4393 1234 5678" }] }),
    ).rejects.toThrow(/full card number isn't accepted/i);
    const res = await op({
      op: "create", name: "FOP Davydzon", type: "sole_proprietor", apply: false,
      identifiers: [{ kind: "card_last4", value: "4149 **** **** 5678" }, { kind: "iban", value: "ua21 3223 1300 0002 6007 2335 6600 1" }],
    });
    expect(res.identifiersAdded).toEqual([{ kind: "card_last4", masked: "•••• 5678" }, { kind: "iban", masked: "UA21…6001" }]);
    const raw = (await db.execute(sql`SELECT value FROM payee_identifiers`)) as unknown as Rows<{ value: string }>;
    const plain = raw.rows.map((r) => decryptField(TEST_DEK, r.value));
    expect(plain).toContain("5678");
    expect(plain.join(" ")).not.toContain("4149");
    await expect(op({ op: "identifiers", entityId: res.entity!.id, add: [{ kind: "iban", value: "nope" }] })).rejects.toThrow(/IBAN/);
  });

  it("turns a rule's payee condition into an alias of the rename target", async () => {
    const { db } = await import("@/db");
    const { encryptRuleFields } = await import("@/lib/rules/crypto");
    const rule = encryptRuleFields(TEST_DEK, {
      name: "bulka",
      conditions: { all: [{ field: "payee", op: "contains", value: "BULOCHKA" }] },
      actions: [{ kind: "rename_payee", to: "Булочка" }],
    } as never) as unknown as { name: string; conditions: unknown; actions: unknown };
    const ins = (await db.execute(sql`
      INSERT INTO transaction_rules (user_id, name, conditions, actions, created_at)
      VALUES (${seed.userId}, ${rule.name}, ${JSON.stringify(rule.conditions)}::jsonb, ${JSON.stringify(rule.actions)}::jsonb, '2026-10-11')
      RETURNING id`)) as unknown as Rows<{ id: number }>;
    const res = await op({ op: "alias_from_rule", ruleId: ins.rows[0].id });
    expect(res.created).toBe(true);
    expect(res.entity!.name).toBe("Булочка");
    expect(res.aliasesAdded).toEqual([{ pattern: "BULOCHKA", mode: "contains" }]);
    expect(res.rows.byTable.transactions).toBe(2);
  });

  it("B23: apply sees every row of a ledger longer than one scan page", async () => {
    const { db } = await import("@/db");
    // 3,000 more rows: ids now span 1–4 digits, the shape that made the old
    // text-ordered keyset skip the fixture rows at ids 3–9 and 30–99.
    await db.execute(sql`
      INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, source, import_hash)
      SELECT ${seed.userId}, '2026-05-01', ${seed.accountId}, 'UAH', -1, 'Filler ' || g, 'import', 'f-' || g
      FROM generate_series(1, 3000) g`);
    const created = await op({ op: "create", name: "Епіцентр", type: "retail", apply: false });
    const preview = await op({ op: "apply", entityIds: [created.entity!.id] }, true);
    expect(preview.rows.byTable.transactions).toBe(8); // Epicentr ×5 + EPITCENTR K10 ×3
    expect(preview.emptyReason).toBeNull();
    const done = await op({ op: "apply", entityIds: [created.entity!.id] });
    expect(done.rows.total).toBe(10);
    const again = await op({ op: "apply", entityIds: [created.entity!.id] }, true);
    expect(again.rows.total).toBe(0);
    expect(again.emptyReason).toMatch(/already have the canonical name/);
  });

  it("adding a cluster to the directory keeps every spelling as an exact alias", async () => {
    const payees = ["Епіцентр", "Epicentr", "EPITCENTR K10 KYIV 360616"];
    const preview = await op({ op: "merge", into: { name: "Епіцентр", type: "retail" }, payees }, true);
    expect(preview.aliasesAdded.map((a) => a.pattern).sort()).toEqual(["EPITCENTR K10 KYIV 360616", "Epicentr"].sort());
    await op({ op: "merge", into: { name: "Епіцентр", type: "retail" }, payees });
    const dir = await (await import("@/lib/payees/directory")).loadDirectory((await import("@/db")).db, seed.userId, TEST_DEK);
    expect(dir[0].aliases.map((a) => a.pattern).sort()).toEqual([...payees].sort());
  });

  it("splits aliases off into a new entity and deletes an entity", async () => {
    const a = await op({ op: "create", name: "Epicentr", apply: false, aliases: [{ pattern: "Епіцентр К" }] });
    const dir = await (await import("@/lib/payees/directory")).loadDirectory((await import("@/db")).db, seed.userId, TEST_DEK);
    const k = dir[0].aliases.find((x) => x.pattern === "Епіцентр К")!;
    const s = await op({ op: "split", entityId: a.entity!.id, aliasIds: [k.id], name: "Епіцентр К", type: "company" });
    expect(s.created).toBe(true);
    expect(s.rows.byTable.transactions).toBe(0); // canonical already equals the spelling
    const d = await op({ op: "delete", entityId: a.entity!.id });
    expect(d.entitiesRemoved).toBe(1);
    const undo = await op({ op: "undo", batchId: d.batchId });
    expect(undo.undo!.restoredEntities).toBe(1);
  });
});
