/**
 * Payee Studio P5b against a real Postgres: look-alikes vs the directory,
 * remembered "different payee" answers, "same payee, move the rest to a tag
 * or note" with its undo, people never applied automatically, and a merged
 * spelling that comes back later ("belongs to the entry, not renamed").
 * SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";
import { mcpTool } from "./helpers/payee-mcp";
import { decryptField, encryptField } from "@/lib/crypto/envelope";
import { encryptStaged, decryptStaged } from "@/lib/crypto/staging-envelope";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Rows<T> = { rows: T[] };

describeDb("Payee Studio P5b look-alikes (seeded DB)", () => {
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
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_rejections, payee_proposals RESTART IDENTITY CASCADE`);
    seed = await seedPayeeLedger();
  });

  const addTx = async (payee: string, date: string, opts: { tags?: string; note?: string; amount?: number } = {}) => {
    const { db } = await import("@/db");
    const r = (await db.execute(sql`
      INSERT INTO transactions (user_id, date, account_id, currency, amount, payee, tags, note, source, import_hash)
      VALUES (${seed.userId}, ${date}, ${seed.accountId}, 'UAH', ${opts.amount ?? -2000}, ${encryptField(TEST_DEK, payee)},
              ${opts.tags ? encryptField(TEST_DEK, opts.tags) : ""}, ${opts.note ? encryptField(TEST_DEK, opts.note) : ""}, 'manual', ${"h-" + randomUUID()})
      RETURNING id`)) as unknown as Rows<{ id: number }>;
    return Number(r.rows[0].id);
  };
  const op = async (o: unknown, dryRun = false) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, op: o as any, actor: "web", dryRun });
  };
  const report = async () => {
    const { db } = await import("@/db");
    const { loadLookalikes, loadPayeeOverview } = await import("@/lib/payees/service");
    const overview = await loadPayeeOverview({ executor: db, userId: seed.userId, dek: TEST_DEK, currency: "UAH" });
    return loadLookalikes({ executor: db, userId: seed.userId, dek: TEST_DEK, overview });
  };
  const rowsOf = async (ids: number[]) => {
    const { db } = await import("@/db");
    const r = (await db.execute(sql`SELECT id, payee, tags, note FROM transactions WHERE user_id = ${seed.userId} AND id = ANY(${sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::int[]`}) ORDER BY id`)) as unknown as Rows<{ id: number; payee: string; tags: string; note: string }>;
    return r.rows.map((x) => ({ id: x.id, raw: x, payee: decryptField(TEST_DEK, x.payee), tags: x.tags ? decryptField(TEST_DEK, x.tags) : "", note: x.note ? decryptField(TEST_DEK, x.note) : "" }));
  };

  it("«Степаненко компенсація житла» is offered for the entry «Степаненко», with the remainder; moving it to a tag is undoable", async () => {
    const plain = [await addTx("Степаненко", "2026-08-01"), await addTx("Степаненко", "2026-09-01")];
    const purpose = [await addTx("Степаненко компенсація житла", "2026-08-15", { tags: "житло" }), await addTx("Степаненко компенсація житла", "2026-09-15")];
    const created = await op({ op: "create", name: "Степаненко", type: "person" });
    expect(created.rows.total).toBe(0);

    const r = await report();
    const c = r.candidates.find((x) => x.name === "Степаненко компенсація житла")!;
    expect(c).toBeTruthy();
    expect(c.entity.name).toBe("Степаненко");
    expect(c.reason).toBe("one name continues the other");
    expect(c.confidence).toBe(0.75);
    expect(c.remainder).toBe("компенсація житла");
    expect(c.needsDecision).toBe(true); // a person: never applied automatically

    const before = await rowsOf(purpose);
    const preview = await op({ op: "move_remainder", entityId: c.entity.id, payees: ["Степаненко компенсація житла"], remainder: c.remainder!, target: "tag" }, true);
    expect(preview.rows.total).toBe(2);
    expect((await rowsOf(purpose)).map((x) => x.payee)).toEqual(["Степаненко компенсація житла", "Степаненко компенсація житла"]);

    const done = await op({ op: "move_remainder", entityId: c.entity.id, payees: ["Степаненко компенсація житла"], remainder: c.remainder!, target: "tag" });
    expect(done.batchId).not.toBeNull();
    const after = await rowsOf(purpose);
    expect(after.map((x) => x.payee)).toEqual(["Степаненко", "Степаненко"]);
    expect(after.map((x) => x.tags)).toEqual(["житло,компенсація житла", "компенсація житла"]);
    expect((await rowsOf(plain)).every((x) => x.tags === "")).toBe(true);
    expect((await report()).candidates.some((x) => x.name === "Степаненко компенсація житла")).toBe(false);

    await op({ op: "undo", batchId: done.batchId });
    const restored = await rowsOf(purpose);
    expect(restored.map((x) => x.raw)).toEqual(before.map((x) => x.raw)); // payee AND tags back, byte for byte
  });

  it("note target appends to the note", async () => {
    const id = await addTx("Степаненко компенсація житла", "2026-08-15", { note: "серпень" });
    const created = await op({ op: "create", name: "Степаненко", type: "person" });
    await op({ op: "move_remainder", entityId: created.entity!.id, payees: ["СТЕПАНЕНКО КОМПЕНСАЦІЯ ЖИТЛА"], remainder: "компенсація житла", target: "note" });
    const [row] = await rowsOf([id]);
    expect(row).toMatchObject({ payee: "Степаненко", note: "серпень; компенсація житла", tags: "" });
  });

  it("a «different payee» answer is remembered and can be cancelled", async () => {
    const created = await op({ op: "create", name: "Епіцентр", type: "retail", aliases: [{ pattern: "Epicentr" }, { pattern: "EPITCENTR K10 KYIV 360616" }] });
    let r = await report();
    const c = r.candidates.find((x) => x.name === "Епіцентр К")!;
    expect(c).toMatchObject({ entity: { id: created.entity!.id }, confidence: 0.9, needsDecision: false });
    const { db } = await import("@/db");
    const { rejectLookalike, cancelRejection } = await import("@/lib/payees/lookalikes");
    expect(await rejectLookalike(db, seed.userId, TEST_DEK, "Епіцентр К", created.entity!.id)).toBe(true);
    expect(await rejectLookalike(db, seed.userId, TEST_DEK, "епіцентр к", created.entity!.id)).toBe(true); // idempotent
    r = await report();
    expect(r.candidates.some((x) => x.name === "Епіцентр К")).toBe(false);
    expect(r.rejectedHidden).toBe(1);
    expect(r.rejections).toEqual([expect.objectContaining({ payee: "Епіцентр К", entityName: "Епіцентр" })]);
    // The table stores a hash, never the spelling.
    const stored = (await db.execute(sql`SELECT key_hash FROM payee_rejections`)) as unknown as Rows<{ key_hash: string }>;
    expect(stored.rows[0].key_hash).not.toMatch(/епіцентр|epikentr/i);
    expect(await cancelRejection(db, seed.userId, TEST_DEK, { id: r.rejections[0].id })).toBe(1);
    expect((await report()).candidates.some((x) => x.name === "Епіцентр К")).toBe(true);
  });

  it("people are never applied automatically: the autopilot skips a person entry, look-alikes write nothing", async () => {
    await addTx("Степаненко", "2026-08-01");
    const created = await op({ op: "create", name: "Степаненко", type: "person" });
    const { db } = await import("@/db");
    const { savePayeeSettings } = await import("@/lib/payees/settings");
    await savePayeeSettings(db, seed.userId, { autopilotEnabled: true, autopilotThreshold: 0.75, importHint: true });
    const stagedImportId = randomUUID();
    await db.execute(sql`
      INSERT INTO staged_imports (id, user_id, source, expires_at, encryption_tier)
      VALUES (${stagedImportId}, ${seed.userId}, 'upload', NOW() + INTERVAL '30 days', 'service')`);
    await db.execute(sql`
      INSERT INTO staged_transactions (id, staged_import_id, user_id, date, amount, currency, payee, row_index, import_hash, encryption_tier)
      VALUES (${randomUUID()}, ${stagedImportId}, ${seed.userId}, '2026-10-01', -2000, 'UAH', ${encryptStaged("Степаненко компенсація житла")}, 0, ${"sh-" + randomUUID()}, 'service')`);
    const { applyPayeeImportAssist } = await import("@/lib/payees/import-assist");
    const res = await applyPayeeImportAssist({ executor: db, userId: seed.userId, dek: TEST_DEK, stagedImportId });
    expect(res.autopilot).toBe(0);
    const st = (await db.execute(sql`SELECT payee FROM staged_transactions WHERE staged_import_id = ${stagedImportId}`)) as unknown as Rows<{ payee: string }>;
    expect(decryptStaged(st.rows[0].payee)).toBe("Степаненко компенсація житла");
    const batchesBefore = (await db.execute(sql`SELECT count(*)::int AS n FROM payee_batches`)) as unknown as Rows<{ n: number }>;
    const r = await report();
    expect(r.candidates.find((x) => x.name === "Степаненко компенсація житла")).toMatchObject({ entity: { id: created.entity!.id }, needsDecision: true });
    const batchesAfter = (await db.execute(sql`SELECT count(*)::int AS n FROM payee_batches`)) as unknown as Rows<{ n: number }>;
    expect(batchesAfter.rows[0].n).toBe(batchesBefore.rows[0].n);
  });

  it("after a merge, a new row 60 days later with the old spelling belongs to the entry, shows as not renamed, and Apply catches it", async () => {
    const { db } = await import("@/db");
    const merged = await op({ op: "merge", into: { name: "Епіцентр", type: "retail" }, payees: ["Епіцентр", "Epicentr", "EPITCENTR K10 KYIV 360616", "Епіцентр К"] });
    expect(merged.rows.total).toBeGreaterThan(0);
    let r = await report();
    expect(r.unrenamed).toEqual([]);
    expect(r.candidates.some((x) => x.entity.name === "Епіцентр")).toBe(false);

    // 60 days later the bank sends the old spelling again (import hint off).
    const late = await addTx("EPITCENTR K10 KYIV 360616", "2026-12-10");
    r = await report();
    expect(r.unrenamed).toEqual([expect.objectContaining({ entityName: "Епіцентр", rows: 1, spellings: [{ spelling: "EPITCENTR K10 KYIV 360616", count: 1 }] })]);
    expect(r.candidates.some((x) => x.name === "EPITCENTR K10 KYIV 360616")).toBe(false); // recognized, not a look-alike

    const apply = await op({ op: "apply", entityIds: [merged.entity!.id] });
    expect(apply.rows.byTable.transactions).toBe(1);
    const row = (await db.execute(sql`SELECT payee FROM transactions WHERE id = ${late}`)) as unknown as Rows<{ payee: string }>;
    expect(decryptField(TEST_DEK, row.rows[0].payee)).toBe("Епіцентр");
    expect((await report()).unrenamed).toEqual([]);
    // The bank ledger keeps its own text.
    const bank = (await db.execute(sql`SELECT payee FROM bank_transactions WHERE user_id = ${seed.userId}`)) as unknown as Rows<{ payee: string }>;
    expect(decryptField(TEST_DEK, bank.rows[0].payee)).toBe("Епіцентр");
  });

  it("MCP lookalikes lists them", async () => {
    await op({ op: "create", name: "Епіцентр", type: "retail" });
    const call = await mcpTool(seed.userId, TEST_DEK);
    const body = { data: await call({ op: "lookalikes" }) };
    expect(body.data.suggestions.map((s: { payee: string }) => s.payee)).toContain("Епіцентр К");
    expect(body.data.unrenamed).toEqual([]); // creating the entry already renamed every stored spelling
  });
});
