import type { ExternalAgentDescriptor } from "@koi/core";
import { AGENT_KEYWORDS, SOURCE_PRIORITY } from "../constants.js";
import type { DiscoverySource, McpAgentSource } from "../types.js";

function qualifies(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return AGENT_KEYWORDS.some((k) => t.includes(k));
}

export function createMcpSource(managers: readonly McpAgentSource[]): DiscoverySource {
  return {
    id: "mcp",
    priority: SOURCE_PRIORITY.mcp,
    discover: async (): Promise<readonly ExternalAgentDescriptor[]> => {
      const out: ExternalAgentDescriptor[] = [];
      for (const m of managers) {
        // Trust boundary: only servers that explicitly declare themselves as
        // agents are surfaced. Keyword matches on tool names alone are not
        // sufficient (a "code_search" tool does not make the server an agent).
        if (m.isAgent !== true) continue;
        let r: Awaited<ReturnType<typeof m.listTools>>;
        try {
          r = await m.listTools();
        } catch {
          continue;
        }
        if (!r.ok) continue;
        const matched = r.value.some((t) => qualifies(t.name) || qualifies(t.description));
        if (!matched) continue;
        out.push({
          name: m.name,
          transport: "mcp",
          capabilities: m.capabilities ?? ["code-generation"],
          healthy: true,
          source: "mcp",
          metadata: { tools: r.value.map((t) => t.name) },
        });
      }
      return out;
    },
  };
}
