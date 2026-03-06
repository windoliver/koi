/**
 * mcp_execute meta-tool — executes tools on an MCP server by name.
 *
 * Used in "discover" mode to let the agent execute a specific tool
 * by name, delegating to the client manager's `callTool()`.
 */

import type { JsonObject, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { McpClientManager } from "../client-manager.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createExecuteTool(serverName: string, client: McpClientManager): Tool {
  const namespacedName = `mcp/${serverName}/mcp_execute`;

  const descriptor: ToolDescriptor = {
    name: namespacedName,
    description: `Execute a tool on MCP server "${serverName}" by name. Use mcp_search to discover available tools first.`,
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "The name of the MCP tool to execute (as returned by mcp_search).",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the tool.",
        },
      },
      required: ["tool"],
    },
  };

  const execute = async (args: JsonObject): Promise<unknown> => {
    const toolName = args.tool;
    if (typeof toolName !== "string" || toolName.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: 'Missing or invalid "tool" field: must be a non-empty string',
        },
      };
    }

    const toolArgs =
      typeof args.args === "object" && args.args !== null ? (args.args as JsonObject) : {};

    const result = await client.callTool(toolName, toolArgs);
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
