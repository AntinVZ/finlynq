/**
 * Call MCP `manage_payees` (and other HTTP tools) in-process for DB tests:
 * registers the whole HTTP tool set on a throwaway McpServer and returns a
 * caller that parses `{ data }` or returns `{ error }`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Tool = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }> };

export async function mcpTool(userId: string, dek: Buffer | null, name = "manage_payees") {
  const { db } = await import("@/db");
  const { registerPgTools } = await import("../../mcp-server/register-tools-pg");
  const { withAutoAnnotations } = await import("../../mcp-server/auto-annotations");
  const server = withAutoAnnotations(new McpServer({ name: "payees-db", version: "0" }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPgTools(server, db as any, userId, dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, Tool>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: Record<string, unknown>): Promise<any> => {
    const raw = (await tools[name].handler(args, {})).content[0].text;
    if (raw.startsWith("Error:")) return { error: raw };
    return JSON.parse(raw).data;
  };
}
