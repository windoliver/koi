/**
 * Tool adapter — wraps MCP tools as Koi Tool components.
 *
 * Tools are namespaced as `mcp/{serverName}/{toolName}` to avoid collisions
 * across servers. Trust tier is always "promoted" since MCP servers are
 * operator-configured.
 */

import type { JsonObject, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { McpClientManager, McpToolInfo } from "./client-manager.js";

/**
 * Converts an MCP tool into a Koi Tool with a namespaced name.
 *
 * The tool delegates execution to the client manager's `callTool()`,
 * which handles reconnection and error mapping.
 */
export function mapMcpToolToKoi(
  toolInfo: McpToolInfo,
  client: McpClientManager,
  serverName: string,
): Tool {
  const namespacedName = `mcp/${serverName}/${toolInfo.name}`;

  const descriptor: ToolDescriptor = {
    name: namespacedName,
    description: toolInfo.description,
    inputSchema: toolInfo.inputSchema,
    ...(toolInfo.tags !== undefined && toolInfo.tags.length > 0 ? { tags: toolInfo.tags } : {}),
  };

  const execute = async (args: JsonObject): Promise<unknown> => {
    const result = await client.callTool(toolInfo.name, args);
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: result.error.code,
          message: result.error.message,
        },
      };
    }
    return result.value;
  };

  return {
    descriptor,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute,
  };
}
