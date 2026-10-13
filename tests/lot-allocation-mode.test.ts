/**
 * The cost-basis method setting and the MCP lot tools (2026-10-13).
 *
 * Lots have been recorded for every trade for months, but the figures a user
 * saw only came from them when an operator flipped a database flag by hand.
 * This makes it a setting the user (or their assistant) controls, and gives
 * the MCP the lot operations the web app already had.
 *
 * Mostly static wiring: what matters is that the web and MCP surfaces share
 * one implementation, and that the switch is safe (it never rebuilds lots a
 * user may have matched by hand).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reassignErrorMessage } from "@/lib/portfolio/lots/reassign-errors";
import { MCP_TOOL_COUNTS } from "@/lib/mcp/tool-counts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Strip comments so a rule quoted in prose can't satisfy a code assertion. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("reassignErrorMessage", () => {
  it("explains each refusal in words a user can act on", () => {
    expect(reassignErrorMessage({ ok: false, code: "close_tx_not_found" })).toMatch(/not found/);
    expect(reassignErrorMessage({ ok: false, code: "no_closures" })).toMatch(/no lot closures/);
    expect(reassignErrorMessage({ ok: false, code: "not_reassignable", closeKind: "transfer_out" })).toContain(
      "transfer_out",
    );
    expect(reassignErrorMessage({ ok: false, code: "qty_mismatch", expected: 100, got: 90 })).toBe(
      "The chosen quantities (90) must total the closure quantity (100)",
    );
    expect(reassignErrorMessage({ ok: false, code: "lot_not_in_scope", lotId: 7 })).toContain("Lot #7");
  });

  it("is the wording both the REST route and the MCP tool use", () => {
    expect(code("src/app/api/portfolio/holdings/[holdingId]/lots/reassign/route.ts")).toContain(
      "reassignErrorMessage(err)",
    );
    expect(code("mcp-server/tools/lots.ts")).toContain("reassignErrorMessage(result)");
  });
});

describe("the cost-basis switch", () => {
  const mode = code("src/lib/portfolio/lots/allocation-mode.ts");

  it("the settings route and the MCP tool both go through the one write path", () => {
    expect(code("src/app/api/settings/lot-allocation/route.ts")).toContain("setLotAllocationEnabled(");
    expect(code("mcp-server/tools/lots.ts")).toContain("setLotAllocationEnabled(");
    for (const p of ["src/app/api/settings/lot-allocation/route.ts", "mcp-server/tools/lots.ts"]) {
      expect(code(p), p).not.toMatch(/portfolioLotsStatus|portfolio_lots_status/);
    }
  });

  // A rebuild matches every sale first in, first out and so resets any
  // matching the user chose by hand. Turning the setting on may therefore only
  // build lots where there are none to lose.
  it("turning it on builds lots only for positions that have none", () => {
    const start = mode.indexOf("export async function setLotAllocationEnabled");
    const body = mode.slice(start);
    expect(body).toContain(".filter((r) => r.noLots)");
    expect(body).not.toContain("buildLotsForUser(");
    const rebuild = body.indexOf("rebuildLotsForPosition(");
    expect(rebuild).toBeGreaterThan(-1);
    expect(body.slice(0, rebuild)).toContain("if (enabled)");
  });

  // The flag is cached per process for 30 seconds; without a bust the next
  // page load would still show the old method.
  it("clears the cached flag after writing it", () => {
    const start = mode.indexOf("export async function setLotAllocationEnabled");
    const write = mode.indexOf("insert(schema.portfolioLotsStatus)", start);
    expect(write).toBeGreaterThan(start);
    expect(mode.indexOf("clearLotsEnabledCache(userId)", write)).toBeGreaterThan(write);
  });

  it("turning it off deletes nothing", () => {
    expect(mode).not.toMatch(/\.delete\(/);
  });

  it("stays the simple method until a user chooses otherwise", () => {
    // No row, or a row never set, reads as off.
    expect(code("src/lib/portfolio/lots/read.ts")).toContain("rows[0]?.enabled ?? false");
  });
});

describe("the figures follow the setting wherever cost basis is shown", () => {
  it("the Portfolio page and the shared valuation both ask the same question", () => {
    expect(code("src/app/api/portfolio/overview/route.ts")).toContain("isLotsEnabledForUser(userId)");
    expect(code("src/lib/holdings-value.ts")).toContain("isLotsEnabledForUser(userId)");
  });

  // Net-worth history values many past dates and only reads market value.
  // Loading every lot for each of them would be wasted work.
  it("the shared valuation loads lots for a current valuation only", () => {
    expect(code("src/lib/holdings-value.ts")).toMatch(/if \(isToday && \(await isLotsEnabledForUser\(userId\)\)\)/);
  });

  it("cash sleeves keep the ledger path in the shared valuation", () => {
    expect(code("src/lib/holdings-value.ts")).toContain(
      "h.isCash === true ? undefined : lotCostBasisByHolding.get(h.id)",
    );
  });
});

describe("MCP manage_lots", () => {
  const mcp = code("mcp-server/tools/lots.ts");

  it("is registered, counted and marked destructive", () => {
    expect(code("mcp-server/register-tools-pg.ts")).toContain("registerLotsTools(server, ctx)");
    expect(MCP_TOOL_COUNTS.http).toBe(55);
    expect(read("README.md")).toContain("55 HTTP / 89 stdio");
    expect(code("mcp-server/auto-annotations.ts")).toContain("manage_lots: { destructiveHint: true }");
    expect(read("scripts/generate-mcp-tool-catalog.mjs")).toContain('"lots",');
  });

  it("reads lots through the same function as the web Lot inspector", () => {
    expect(mcp).toContain("loadHoldingLotsAndClosures(");
    expect(code("src/app/api/portfolio/holdings/[holdingId]/lots/route.ts")).toContain(
      "loadHoldingLotsAndClosures(",
    );
  });

  it("changes a sale's lots and rebuilds a position through the web app's own functions", () => {
    expect(mcp).toContain("reassignClosureLots(");
    expect(mcp).toContain("rebuildLotsForPosition(");
    expect(mcp).toContain("resolvePositionScope(");
    expect(code("src/app/api/portfolio/holdings/[holdingId]/lots/rebuild/route.ts")).toContain(
      "resolvePositionScope(",
    );
  });

  it("previews a reassignment unless told to apply it", () => {
    expect(mcp).toContain("const dryRun = args.preview !== false");
  });

  it("refuses a rebuild without an explicit confirmation, before touching anything", () => {
    const start = mcp.indexOf("async function opRebuild");
    const guard = mcp.indexOf("args.confirm_reset !== true", start);
    const rebuild = mcp.indexOf("rebuildLotsForPosition(", start);
    expect(guard).toBeGreaterThan(start);
    expect(rebuild).toBeGreaterThan(guard);
  });

  it("never writes a transaction", () => {
    expect(mcp).not.toMatch(/createTransaction|INSERT INTO transactions|UPDATE transactions|DELETE FROM transactions/i);
  });
});

describe("the explanation", () => {
  const ui = read("src/components/portfolio/cost-basis-method.tsx");

  // Buy 100 at 10, buy 100 at 20, sell 100, buy 100 at 30: 200 shares held.
  it("its worked example adds up", () => {
    const simple = ((100 * 10 + 100 * 20 + 100 * 30) / 300) * 200;
    const fifo = 100 * 20 + 100 * 30;
    expect(simple).toBe(4000);
    expect(fifo).toBe(5000);
    expect(ui).toContain("4,000");
    expect(ui).toContain("5,000");
  });

  it("is on the settings page and referenced from the Portfolio page", () => {
    expect(read("src/app/(app)/settings/investments/page.tsx")).toContain("<CostBasisSetting />");
    expect(read("src/app/(app)/portfolio/_components/holdings-table.tsx")).toContain("<CostBasisNote />");
    expect(ui).toContain('"/settings/investments#cost-basis"');
    expect(ui).toContain('id="cost-basis"');
  });
});
