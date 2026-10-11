/**
 * Payee Studio P3 against a real Postgres: review pack, proposals (drafts →
 * approve as one batch → undo back to draft), MCP two-step approve, the
 * import hint and the autopilot. SKIPS unless DATABASE_URL names a `*_test`
 * database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger, type SeededPayees } from "./helpers/payee-db-seed";
import { decryptField } from "@/lib/crypto/envelope";
import { decryptStaged, encryptStaged } from "@/lib/crypto/staging-envelope";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type Rows<T> = { rows: T[] };

describeDb("Payee Studio P3 AI layer (seeded DB)", () => {
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
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches, payee_proposals RESTART IDENTITY CASCADE`);
    seed = await seedPayeeLedger();
  });

  const mcp = async () => {
    const { db } = await import("@/db");
    const { registerPgTools } = await import("../mcp-server/register-tools-pg");
    const { withAutoAnnotations } = await import("../mcp-server/auto-annotations");
    const server = withAutoAnnotations(new McpServer({ name: "payees-ai", version: "0" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerPgTools(server, db as any, seed.userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    return async (args: Record<string, unknown>) => {
      const raw = (await tools.manage_payees.handler(args, {})).content[0].text;
      return raw.startsWith("Error:") ? { error: raw } : JSON.parse(raw).data;
    };
  };
  const txCount = async (payee: string) => {
    const { db } = await import("@/db");
    const r = (await db.execute(sql`SELECT payee FROM transactions WHERE user_id = ${seed.userId}`)) as unknown as Rows<{ payee: string }>;
    return r.rows.filter((x) => decryptField(TEST_DEK, x.payee) === payee).length;
  };

  it("review → propose (drafts only) → approve as one batch → undo returns drafts", async () => {
    const call = await mcp();
    const pack = await call({ op: "review", limit: 20 });
    expect(pack.stats.unrecognized).toBeGreaterThan(5);
    const epi = pack.unrecognized.find((u: { payee: string }) => u.payee === "Епіцентр");
    expect(epi.spellings).toContain("EPITCENTR K10 KYIV 360616");
    expect(epi.examples).toHaveLength(3);
    expect(pack.unrecognized.find((u: { payee: string }) => u.payee === "Деркач Олександр Петрович").person).toBe(true);
    expect(pack.howTo).toMatch(/Nothing changes until the user approves/);

    const proposed = await call({
      op: "propose",
      proposals: [
        { canonical: "Епіцентр", type: "retail", aliases: ["Epicentr", "EPITCENTR K10 KYIV 360616", "Епіцентр К"], reason: "Same store chain", confidence: 0.95 },
        { canonical: "ATB", type: "retail", aliases: ["Атб Маркет", "ATB MARKET"], reason: "ATB supermarket", confidence: 0.92, identifiers: [{ kind: "card_last4", value: "5375 4141 0000 1234" }] },
        { canonical: "Деркач Олександр Петрович", type: "person", aliases: ["DERKACH OLEKSANDR PETROVYCH"], reason: "Same person", confidence: 0.97 },
        { canonical: "", reason: "broken" },
      ],
    });
    expect(proposed.saved).toHaveLength(3);
    expect(proposed.rejected).toHaveLength(1);
    expect(proposed.saved[2].needsDecision).toBe(true);
    expect(await txCount("Епіцентр")).toBe(20); // drafts change nothing
    const { db } = await import("@/db");
    const stored = (await db.execute(sql`SELECT payload FROM payee_proposals`)) as unknown as Rows<{ payload: string }>;
    expect(stored.rows.every((r) => r.payload.startsWith("v1:"))).toBe(true);
    expect(stored.rows.map((r) => decryptField(TEST_DEK, r.payload)).join(" ")).not.toContain("5375");

    const listed = await call({ op: "proposals" });
    expect(listed.proposals.find((p: { canonical: string }) => p.canonical === "ATB").identifiers[0].value).toBe("•••• 1234");
    const pack2 = await call({ op: "review" });
    expect(pack2.unrecognized.find((u: { payee: string }) => u.payee === "Епіцентр").proposed).toBe(true);

    const ids = proposed.saved.slice(0, 2).map((x: { proposal_id: number }) => x.proposal_id);
    const preview = await call({ op: "approve", proposal_ids: ids });
    expect(preview.preview).toBe(true);
    expect(preview.rows.byTable.transactions).toBe(10 + 10); // Epicentr spellings + both ATB spellings
    const done = await call({ op: "approve", proposal_ids: ids, confirmation_token: preview.confirmationToken });
    expect(done.approved).toEqual(ids);
    expect(await txCount("Епіцентр")).toBe(30);
    expect(await txCount("ATB")).toBe(10);
    const after = await call({ op: "proposals", status: "approved" });
    expect(after.proposals.every((p: { batch_id: number }) => p.batch_id === done.batch_id)).toBe(true);
    const aliases = (await db.execute(sql`SELECT source FROM payee_aliases WHERE source = 'proposal'`)) as unknown as Rows<unknown>;
    // Spellings sharing the canonical's matching key need no alias: only "Епіцентр К" and "Атб Маркет" / "ATB MARKET" (one key) remain.
    expect(aliases.rows.length).toBe(2);

    const u = { op: "undo", batch_id: done.batch_id };
    await call({ ...u, confirmation_token: (await call(u)).confirmationToken });
    expect((await call({ op: "proposals" })).total).toBe(3);
    expect(await txCount("Епіцентр")).toBe(20);

    expect((await call({ op: "reject", proposal_ids: [proposed.saved[2].proposal_id] })).rejected).toBe(1);
  });

  it("approval names the failing proposal and rolls everything back", async () => {
    const { executePayeeOp } = await import("@/lib/payees/ops");
    const { saveProposals, approveProposals } = await import("@/lib/payees/proposals");
    const { db } = await import("@/db");
    const res = await saveProposals({
      executor: db, userId: seed.userId, dek: TEST_DEK,
      proposals: [{ canonical: "Колінс", aliases: ["Colin's"], confidence: 0.9 }, { canonical: "Colins Cafe", aliases: ["Colin’s"], confidence: 0.9 }],
    });
    // Someone claims "Colin's" for another entity before the approval.
    await executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, actor: "web", op: { op: "create", name: "Colin's Coffee", apply: false, aliases: [{ pattern: "Colin's" }] } });
    await expect(approveProposals({ executor: db, userId: seed.userId, dek: TEST_DEK, actor: "web", ids: res.saved.map((s) => s.id) })).rejects.toThrow(/proposal #\d+ \("Колінс"\): .* already belongs to "Colin's Coffee"/);
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM payee_entities`)) as unknown as Rows<{ n: number }>;
    expect(n.rows[0].n).toBe(1);
  });

  it("import hint and autopilot: off by default, journaled, never for people", async () => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    const { applyPayeeImportAssist, canonicalPayeeHint, autopilotMatch } = await import("@/lib/payees/import-assist");
    const { savePayeeSettings } = await import("@/lib/payees/settings");
    const { loadDirectory } = await import("@/lib/payees/directory");
    await executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, actor: "web", op: { op: "create", name: "Епіцентр", type: "retail", apply: false } });
    await executePayeeOp({ executor: db, userId: seed.userId, dek: TEST_DEK, actor: "web", op: { op: "create", name: "Деркач Олександр Петрович", type: "person", apply: false } });
    // New rows in the seeded staged import: a near spelling and a person look-alike.
    let i = 10;
    for (const p of ["Епіцентр К", "Деркач Олександр"]) {
      await db.execute(sql`
        INSERT INTO staged_transactions (id, staged_import_id, user_id, date, amount, currency, payee, row_index, import_hash, encryption_tier)
        VALUES (${randomUUID()}, ${seed.stagedImportId}, ${seed.userId}, '2026-10-02', -10, 'UAH', ${encryptStaged(p)}, ${i++}, ${"sh-" + randomUUID()}, 'service')`);
    }
    const staged = async () => {
      const r = (await db.execute(sql`SELECT payee, import_hash, encryption_tier FROM staged_transactions WHERE user_id = ${seed.userId} ORDER BY row_index`)) as unknown as Rows<{ payee: string; import_hash: string; encryption_tier: string }>;
      return r.rows;
    };
    const before = await staged();

    const off = await applyPayeeImportAssist({ executor: db, userId: seed.userId, dek: TEST_DEK, stagedImportId: seed.stagedImportId });
    expect(off).toEqual({ hinted: 0, autopilot: 0, aliasesAdded: 0, batchIds: [] });
    expect(await canonicalPayeeHint(db, seed.userId, TEST_DEK, "EPICENTR")).toBeNull();

    await savePayeeSettings(db, seed.userId, { importHint: true, autopilotEnabled: true, autopilotThreshold: 0.9 });
    const res = await applyPayeeImportAssist({ executor: db, userId: seed.userId, dek: TEST_DEK, stagedImportId: seed.stagedImportId });
    expect(res).toMatchObject({ hinted: 1, autopilot: 1, aliasesAdded: 1 });
    expect(res.batchIds).toHaveLength(2);
    const after = await staged();
    expect(after.map((r) => decryptStaged(r.payee))).toEqual(["ATB MARKET", "Епіцентр", "Епіцентр", "Деркач Олександр"]);
    expect(after.map((r) => r.import_hash)).toEqual(before.map((r) => r.import_hash));
    expect(after.every((r) => r.encryption_tier === "service")).toBe(true);
    const dir = await loadDirectory(db, seed.userId, TEST_DEK);
    expect(dir.find((e) => e.name === "Епіцентр")!.aliases.find((a) => a.source === "autopilot")!.pattern).toBe("Епіцентр К");
    // People: never matched fuzzily, either direction.
    expect(autopilotMatch("Деркач Олександр", dir, 0.75)).toBeNull();
    expect(await canonicalPayeeHint(db, seed.userId, TEST_DEK, "EPITCENTR K10 KYIV 111111")).toBe("Епіцентр");

    // Both batches undo (newest first).
    const { undoPayeeBatch } = await import("@/lib/payees/batches");
    await undoPayeeBatch({ executor: db, userId: seed.userId, dek: TEST_DEK, batchId: res.batchIds[1] });
    await undoPayeeBatch({ executor: db, userId: seed.userId, dek: TEST_DEK, batchId: res.batchIds[0] });
    expect((await staged()).map((r) => decryptStaged(r.payee))).toEqual(["ATB MARKET", "EPITCENTR K10 KYIV 360616", "Епіцентр К", "Деркач Олександр"]);
  });
});
