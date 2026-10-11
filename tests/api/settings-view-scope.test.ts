/**
 * GET/PUT /api/settings/usage-mode and /api/settings/view-scope — auth,
 * validation (400 on anything but the exact values) and persistence through
 * lib/settings/view-scope-settings.ts. No database: the settings helper is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () =>
    auth.ok
      ? { authenticated: true, context: { userId: "u1", method: "passphrase" as const, mfaVerified: false, dek: null, sessionId: "s" } }
      : { authenticated: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) },
  ),
}));

const store = vi.hoisted(() => ({
  getUsageMode: vi.fn(),
  setUsageMode: vi.fn(),
  getViewScope: vi.fn(),
  setViewScope: vi.fn(),
}));
vi.mock("@/lib/settings/view-scope-settings", () => store);

import * as usageRoute from "@/app/api/settings/usage-mode/route";
import * as scopeRoute from "@/app/api/settings/view-scope/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const put = async (mod: typeof usageRoute | typeof scopeRoute, path: string, body: unknown) =>
  parseResponse(await mod.PUT(createMockRequest(`http://localhost:3000${path}`, { method: "PUT", body })));
const get = async (mod: typeof usageRoute | typeof scopeRoute, path: string) =>
  parseResponse(await mod.GET(createMockRequest(`http://localhost:3000${path}`)));

describe("/api/settings/usage-mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.ok = true;
    store.getUsageMode.mockResolvedValue("personal");
  });

  it("GET returns the stored mode", async () => {
    store.getUsageMode.mockResolvedValue("business_too");
    const { status, data } = await get(usageRoute, "/api/settings/usage-mode");
    expect(status).toBe(200);
    expect(data).toEqual({ usageMode: "business_too" });
    expect(store.getUsageMode).toHaveBeenCalledWith("u1");
  });

  it("PUT saves a valid mode", async () => {
    const { status, data } = await put(usageRoute, "/api/settings/usage-mode", { usageMode: "business_too" });
    expect(status).toBe(200);
    expect(data).toEqual({ usageMode: "business_too" });
    expect(store.setUsageMode).toHaveBeenCalledWith("u1", "business_too");
  });

  it.each([{ usageMode: "business" }, { usageMode: true }, {}, null])("PUT %j → 400, nothing saved", async (body) => {
    const { status } = await put(usageRoute, "/api/settings/usage-mode", body);
    expect(status).toBe(400);
    expect(store.setUsageMode).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    auth.ok = false;
    expect((await get(usageRoute, "/api/settings/usage-mode")).status).toBe(401);
    expect((await put(usageRoute, "/api/settings/usage-mode", { usageMode: "personal" })).status).toBe(401);
    expect(store.setUsageMode).not.toHaveBeenCalled();
  });
});

describe("/api/settings/view-scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.ok = true;
    store.getViewScope.mockResolvedValue("all");
  });

  it("GET returns the stored scope", async () => {
    store.getViewScope.mockResolvedValue("personal");
    const { data } = await get(scopeRoute, "/api/settings/view-scope");
    expect(data).toEqual({ viewScope: "personal" });
  });

  it.each(["all", "business", "personal"])("PUT saves %s", async (viewScope) => {
    const { status, data } = await put(scopeRoute, "/api/settings/view-scope", { viewScope });
    expect(status).toBe(200);
    expect(data).toEqual({ viewScope });
    expect(store.setViewScope).toHaveBeenCalledWith("u1", viewScope);
  });

  it.each([{ viewScope: "true" }, { viewScope: "Business" }, { scope: "all" }])("PUT %j → 400", async (body) => {
    const { status } = await put(scopeRoute, "/api/settings/view-scope", body);
    expect(status).toBe(400);
    expect(store.setViewScope).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    auth.ok = false;
    expect((await put(scopeRoute, "/api/settings/view-scope", { viewScope: "all" })).status).toBe(401);
  });
});
