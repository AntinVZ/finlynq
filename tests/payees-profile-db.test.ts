/**
 * Payee Studio P5c against a real Postgres: website + logo stored encrypted,
 * undone with the batch, served as an image, set over MCP (two-step), shown
 * in the review pack (has_website), proposed by the AI (not for people).
 * SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

let authedUser = "";
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: authedUser, method: "account", dek: Buffer.alloc(32, 0xaa), sessionId: "test-session" },
  })),
}));

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { sql } from "drizzle-orm";
import { bootstrapTestDb, resetTestDb, shutdownTestDb, TEST_DEK } from "./helpers/portfolio-fixtures";
import { seedPayeeLedger } from "./helpers/payee-db-seed";
import { mcpTool } from "./helpers/payee-mcp";
import { createMockRequest } from "./helpers/api-test-utils";
import { PNG_1PX } from "./helpers/payee-fixtures";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;
type Rows<T> = { rows: T[] };

describeDb("Payee Studio P5c website + logo (seeded DB)", () => {
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
    authedUser = (await seedPayeeLedger()).userId;
  });

  const op = async (o: unknown, dryRun = false) => {
    const { db } = await import("@/db");
    const { executePayeeOp } = await import("@/lib/payees/ops");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return executePayeeOp({ executor: db, userId: authedUser, dek: TEST_DEK, op: o as any, actor: "web", dryRun });
  };

  it("stores website and logo encrypted, serves the logo, undo restores the profile", async () => {
    const { db } = await import("@/db");
    const created = await op({ op: "create", name: "Епіцентр", type: "retail", website: "epicentrk.ua" });
    const id = created.entity!.id;
    const set = await op({ op: "update", entityId: id, website: "http://www.epicentrk.ua/uk/", logo: `data:image/png;base64,${PNG_1PX}`, apply: false });
    const raw = (await db.execute(sql`SELECT website, logo FROM payee_entities WHERE id = ${id}`)) as unknown as Rows<{ website: string; logo: string }>;
    expect(raw.rows[0].website.startsWith("v1:")).toBe(true);
    expect(raw.rows[0].logo.startsWith("v1:")).toBe(true);
    const { loadDirectory } = await import("@/lib/payees/directory");
    expect((await loadDirectory(db, authedUser, TEST_DEK))[0]).toMatchObject({ website: "https://www.epicentrk.ua/uk", logo: expect.stringMatching(/^data:image\/png;base64,/) });

    const route = await import("@/app/api/payees/[id]/logo/route");
    const res = await route.GET(createMockRequest(`http://localhost:3000/api/payees/${id}/logo`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG_1PX, "base64"))).toBe(true);

    await expect(op({ op: "update", entityId: id, logo: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}` })).rejects.toThrow(/SVG/);
    await expect(op({ op: "update", entityId: id, website: "javascript:alert(1)" })).rejects.toThrow(/http and https/);

    await op({ op: "undo", batchId: set.batchId });
    const back = (await loadDirectory(db, authedUser, TEST_DEK))[0];
    expect(back).toMatchObject({ website: "https://epicentrk.ua", logo: null });
    const gone = await route.GET(createMockRequest(`http://localhost:3000/api/payees/${id}/logo`));
    expect(gone.status).toBe(404);
  });

  it("MCP set_profile is two-step; review marks has_website; proposals carry websites but not for people", async () => {
    const call = await mcpTool(authedUser, TEST_DEK);
    const created = await op({ op: "create", name: "Епіцентр", type: "retail" });
    const id = created.entity!.id;
    let review = await call({ op: "review" });
    expect(review.directory[0]).toMatchObject({ entity_id: id, has_website: false });
    const preview = await call({ op: "set_profile", entity_id: id, website: "epicentrk.ua" });
    expect(preview.preview).toBe(true);
    const done = await call({ op: "set_profile", entity_id: id, website: "epicentrk.ua", confirmation_token: preview.confirmationToken });
    expect(done.batch_id).toBeGreaterThan(0);
    review = await call({ op: "review" });
    expect(review.directory[0].has_website).toBe(true);
    const got = await call({ op: "get", entity_id: id });
    expect(got.entity.website).toBe("https://epicentrk.ua");

    const saved = await call({
      op: "propose",
      proposals: [
        { canonical: "Сільпо", type: "retail", aliases: ["SILPO"], website: "silpo.ua", confidence: 0.9 },
        { canonical: "Деркач Олександр Петрович", type: "person", website: "derkach.me", confidence: 0.9 },
      ],
    });
    expect(saved.saved[1].notes[0]).toMatch(/Website skipped/);
    const list = await call({ op: "proposals" });
    expect(list.proposals.find((p: { canonical: string }) => p.canonical === "Сільпо").website).toBe("https://silpo.ua");
    const silpo = list.proposals.find((p: { canonical: string }) => p.canonical === "Сільпо").proposal_id;
    const pv = await call({ op: "approve", proposal_ids: [silpo] });
    await call({ op: "approve", proposal_ids: [silpo], confirmation_token: pv.confirmationToken });
    const { db } = await import("@/db");
    const { loadDirectory } = await import("@/lib/payees/directory");
    expect((await loadDirectory(db, authedUser, TEST_DEK)).find((e) => e.name === "Сільпо")?.website).toBe("https://silpo.ua");
  });
});
