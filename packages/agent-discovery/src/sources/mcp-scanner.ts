/**
 * MCP scanner — discovers agents from MCP server managers.
 *
 * Maps MCP servers that expose agent-like tools into ExternalAgentDescriptor.
 * Uses dependency-injected McpAgentSource to avoid coupling to the MCP package.
 */

import type { ExternalAgentDescriptor } from "@koi/core";
import type { DiscoverySource, McpAgentSource } from "../types.js";

/**
 * Heuristic keywords that suggest a tool is agent-like.
 *
 * NOTE: broad keywords ("code", "generate") may produce false positives
 * for non-agent tools (e.g., "qr_code_scanner"). Callers with stricter
 * requirements should pre-filter McpAgentSource results.
 */
const AGENT_KEYWORDS = ["agent", "assistant", "code", "chat", "generate", "review"];

/** Check if a tool name or description suggests agent-like capabilities. */
function isAgentLikeTool(name: string, description: string): boolean {
  const combined = `${name} ${description}`.toLowerCase();
  return AGENT_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * Creates a DiscoverySource that discovers agents from MCP server managers.
 * Each MCP server that exposes agent-like tools becomes an ExternalAgentDescriptor.
 */
export function createMcpSource(managers: readonly McpAgentSource[]): DiscoverySource {
  return {
    name: "mcp",

    discover: async (): Promise<readonly ExternalAgentDescriptor[]> => {
      const results = await Promise.allSettled(
        managers.map(async (manager) => {
          const result = await manager.listTools();
          if (!result.ok) return [];

          const agentTools = result.value.filter((t) => isAgentLikeTool(t.name, t.description));

          if (agentTools.length === 0) return [];

          const capabilities = agentTools.map((t) => t.name);

          const descriptor: ExternalAgentDescriptor = {
            name: `mcp-${manager.name}`,
            displayName: manager.name,
            transport: "mcp",
            capabilities,
            healthy: true,
            source: "mcp",
            metadata: {
              serverName: manager.name,
              toolCount: agentTools.length,
            },
          };

          return [descriptor];
        }),
      );

      return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    },
  };
}
