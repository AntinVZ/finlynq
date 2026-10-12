/**
 * B16: manage_payees is registered on the stdio MCP server. Starts the real
 * stdio process (tsx mcp-server/index.ts) against the test database, lists
 * the tools and calls manage_payees — stdio has no DEK, so reads work on
 * plaintext only and writes ask for the unlock.
 * SKIPS unless DATABASE_URL names a `*_test` database.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { Client } from "pg";
import { MCP_TOOL_COUNTS } from "@/lib/mcp/tool-counts";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

describeDb("stdio MCP: manage_payees (B16)", () => {
  it("is listed and answers without a DEK", async () => {
    const pg = new Client({ connectionString: DB_URL });
    await pg.connect();
    const userId = randomUUID();
    await pg.query(
      `INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at) VALUES ($1, $2, $3, 'x', 'user', now()::text, now()::text)`,
      [userId, `stdio-${userId.slice(0, 8)}`, `${userId.slice(0, 8)}@test.local`],
    );
    const root = path.resolve(__dirname, "..");
    const child = spawn(path.join(root, "node_modules", ".bin", "tsx"), ["mcp-server/index.ts"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: DB_URL, PF_USER_ID: userId },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map<number, (v: unknown) => void>();
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id != null) pending.get(msg.id)?.(msg);
        } catch {
          /* not JSON-RPC */
        }
      }
    });
    let nextId = 1;
    const rpc = (method: string, params: unknown) =>
      new Promise<{ result?: Record<string, unknown>; error?: unknown }>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve as (v: unknown) => void);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const list = await rpc("tools/list", {});
      const tools = (list.result?.tools as Array<{ name: string }>) ?? [];
      expect(tools.some((t) => t.name === "manage_payees")).toBe(true);
      expect(tools.length).toBe(MCP_TOOL_COUNTS.stdio);
      const read = await rpc("tools/call", { name: "manage_payees", arguments: { op: "list" } });
      const readText = ((read.result?.content as Array<{ text: string }>) ?? [])[0]?.text ?? "";
      expect(readText).toMatch(/No decryption key/);
      const write = await rpc("tools/call", { name: "manage_payees", arguments: { op: "create", name: "Епіцентр" } });
      const writeText = ((write.result?.content as Array<{ text: string }>) ?? [])[0]?.text ?? "";
      expect(writeText).toMatch(/Unlock required/);
    } finally {
      child.kill();
      await pg.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await pg.end();
    }
  }, 60_000);
});
