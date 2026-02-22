/**
 * mcp_search meta-tool — searches pre-loaded MCP tool lists.
 *
 * Used in "discover" mode to let the agent search for available tools
 * by substring match on name + description (case-insensitive).
 * No network call — tool list is captured at creation time.
 */

import type { JsonObject, Tool, ToolDescriptor } from "@koi/core";
import type { McpToolInfo } from "../client-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createSearchTool(serverName: string, tools: readonly McpToolInfo[]): Tool {
  const namespacedName = `mcp/${serverName}/mcp_search`;

  const descriptor: ToolDescriptor = {
    name: namespacedName,
    description: `Search available tools on MCP server "${serverName}". Returns matching tool names and descriptions.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Substring to search for in tool names and descriptions. Leave empty to list all.",
        },
        limit: {
          type: "number",
          description: `Maximum number of results to return. Default: ${DEFAULT_LIMIT}`,
        },
      },
    },
  };

  const execute = async (args: JsonObject): Promise<unknown> => {
    const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const limit =
      typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT;

    const matches =
      query === ""
        ? tools
        : tools.filter(
            (t) =>
              t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query),
          );

    const limited = matches.slice(0, limit);

    return {
      total: matches.length,
      returned: limited.length,
      tools: limited.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  };

  return {
    descriptor,
    trustTier: "promoted",
    execute,
  };
}
