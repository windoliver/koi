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
        const r = await m.listTools();
        if (!r.ok) continue;
        const matched = r.value.some((t) => qualifies(t.name) || qualifies(t.description));
        if (matched) {
          out.push({
            name: m.name,
            transport: "mcp",
            capabilities: ["code-generation"],
            healthy: true,
            source: "mcp",
            metadata: { tools: r.value.map((t) => t.name) },
          });
        }
      }
      return out;
    },
  };
}
