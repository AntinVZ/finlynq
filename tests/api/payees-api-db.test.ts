/**
 * /api/payees routes against a real Postgres (only the session is stubbed).
 * SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { TEST_DEK } from "../helpers/portfolio-fixtures";

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
import { bootstrapTestDb, resetTestDb, shutdownTestDb } from "../helpers/portfolio-fixtures";
import { seedPayeeLedger } from "../helpers/payee-db-seed";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("/api/payees (seeded DB)", () => {
  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);
  afterAll(async () => {
    await shutdownTestDb();
  });

  it("GET overview, POST dry run / commit / errors, entity page, settings", async () => {
    expect(TEST_DEK.equals(Buffer.alloc(32, 0xaa))).toBe(true);
    await resetTestDb();
    const { db } = await import("@/db");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches RESTART IDENTITY CASCADE`);
    authedUser = (await seedPayeeLedger()).userId;
    const route = await import("@/app/api/payees/route");
    const entityRoute = await import("@/app/api/payees/[id]/route");
    const settingsRoute = await import("@/app/api/payees/settings/route");
    const post = async (body: unknown) => parseResponse(await route.POST(createMockRequest("http://localhost:3000/api/payees", { method: "POST", body })));

    const overview = (await parseResponse(await route.GET(createMockRequest("http://localhost:3000/api/payees")))).data as {
      groups: Array<{ name: string; entityId: number | null }>;
      entities: unknown[];
      settings: { advancedMode: boolean };
    };
    expect(overview.groups[0].name).toBe("Епіцентр");
    expect(overview.entities).toEqual([]);
    expect(overview.settings.advancedMode).toBe(false);

    const dry = await post({ op: "create", name: "Епіцентр", dryRun: true });
    expect(dry.status).toBe(200);
    expect((dry.data as { rows: { total: number } }).rows.total).toBe(10);
    const created = await post({ op: "create", name: "Епіцентр" });
    const entityId = (created.data as { entity: { id: number } }).entity.id;
    expect((await post({ op: "create", name: "Epicentr" })).status).toBe(409); // alias conflict
    expect((await post({ op: "update", entityId: 9999, name: "x" })).status).toBe(404);
    expect((await post({ op: "nope" })).status).toBe(400);

    const page = (await parseResponse(await entityRoute.GET(createMockRequest(`http://localhost:3000/api/payees/${entityId}`)))).data as {
      entity: { name: string };
      spellings: Array<{ count: number }>;
      history: unknown[];
      pending: { total: number };
    };
    expect(page.entity.name).toBe("Епіцентр");
    expect(page.spellings.reduce((n, g) => n + g.count, 0)).toBe(28);
    expect(page.history).toHaveLength(1);
    expect(page.pending.total).toBe(0);

    const saved = await parseResponse(await settingsRoute.PUT(createMockRequest("http://localhost:3000/api/payees/settings", { method: "PUT", body: { advancedMode: true } })));
    expect(saved.data).toMatchObject({ advancedMode: true });
    expect((await parseResponse(await settingsRoute.GET(createMockRequest("http://localhost:3000/api/payees/settings")))).data).toMatchObject({ advancedMode: true });
  });

  it("P5a: GET /api/payees/suggest and /api/payees/explain", async () => {
    await resetTestDb();
    const { db } = await import("@/db");
    await db.execute(sql`TRUNCATE payee_entities, payee_aliases, payee_identifiers, payee_batches RESTART IDENTITY CASCADE`);
    const { __clearAll } = await import("@/lib/mcp/user-tx-cache");
    __clearAll();
    authedUser = (await seedPayeeLedger()).userId;
    const route = await import("@/app/api/payees/route");
    const suggest = await import("@/app/api/payees/suggest/route");
    const explain = await import("@/app/api/payees/explain/route");
    await route.POST(createMockRequest("http://localhost:3000/api/payees", { method: "POST", body: { op: "create", name: "Епіцентр", payees: [] } }));
    const get = async (url: string) => parseResponse(await suggest.GET(createMockRequest(url)));
    const res = (await get("http://localhost:3000/api/payees/suggest?q=epit&limit=5")).data as { suggestions: Array<{ value: string; kind: string }> };
    expect(res.suggestions[0]).toMatchObject({ value: "Епіцентр", kind: "entity" });
    const recent = (await get("http://localhost:3000/api/payees/suggest?q=bulo")).data as { suggestions: Array<{ value: string; kind: string; count?: number }> };
    expect(recent.suggestions).toEqual([expect.objectContaining({ value: "BULOCHKA SHOP", kind: "recent", count: 2 })]);

    const ex = await parseResponse(await explain.GET(createMockRequest("http://localhost:3000/api/payees/explain?a=Epicentr&b=" + encodeURIComponent("Епіцентр К"))));
    expect(ex.status).toBe(200);
    expect(ex.data).toMatchObject({ verdict: "clustered", score: { confidence: 0.9 }, a: { entity: { name: "Епіцентр" } }, b: { entity: null } });
    const bad = await parseResponse(await explain.GET(createMockRequest("http://localhost:3000/api/payees/explain?a=x")));
    expect(bad.status).toBe(400);
  });
});
