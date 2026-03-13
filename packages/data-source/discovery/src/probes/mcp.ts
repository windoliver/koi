/**
 * MCP probe — queries connected MCP servers via tools/list
 * and builds descriptors for data-related tools.
 */

import type { DataSourceProbeResult, McpServerDescriptor } from "../types.js";

/** Probe MCP servers for data-related tools with a per-server timeout. */
export async function probeMcp(
  servers: readonly McpServerDescriptor[],
  timeoutMs: number,
): Promise<readonly DataSourceProbeResult[]> {
  const results: DataSourceProbeResult[] = [];

  const probes = servers.map(async (server): Promise<readonly DataSourceProbeResult[]> => {
    try {
      const tools = await Promise.race([
        server.listTools(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`MCP probe timeout: ${server.name}`)), timeoutMs),
        ),
      ]);

      return tools
        .filter((t) => isDataTool(t.name, t.description))
        .map(
          (tool): DataSourceProbeResult => ({
            source: "mcp",
            descriptor: {
              name: `mcp-${server.name}-${tool.name}`,
              protocol: "mcp",
              description: tool.description ?? `MCP tool: ${tool.name}`,
            },
          }),
        );
    } catch {
      // Probe failures are non-fatal — skip this server
      return [];
    }
  });

  const settled = await Promise.allSettled(probes);
  for (const result of settled) {
    if (result.status === "fulfilled") {
      results.push(...result.value);
    }
  }

  return results;
}

/** Heuristic: is this tool likely a data access tool? */
function isDataTool(name: string, description?: string): boolean {
  const keywords = ["query", "sql", "database", "db", "table", "schema", "select", "insert"];
  const text = `${name} ${description ?? ""}`.toLowerCase();
  return keywords.some((kw) => text.includes(kw));
}
