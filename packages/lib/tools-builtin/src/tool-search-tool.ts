import type { JsonObject, Tool, ToolPolicy, ToolSummary } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { DEFAULT_MAX_RESULTS } from "./constants.js";

export interface ToolSearchConfig {
  readonly getTools: () => readonly ToolSummary[];
  readonly policy?: ToolPolicy;
}

export function createToolSearchTool(config: ToolSearchConfig): Tool {
  const { getTools, policy = DEFAULT_UNSANDBOXED_POLICY } = config;

  return {
    descriptor: {
      name: "ToolSearch",
      description:
        "Search available tools by keyword or fetch exact tools by name. " +
        'Use "select:Name1,Name2" for exact lookup, or keywords for fuzzy search.',
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Search query. Use "select:Read,Edit" for exact names, or keywords to search.',
          },
          max_results: {
            type: "number",
            description: `Maximum results to return (default ${DEFAULT_MAX_RESULTS})`,
          },
        },
        required: ["query"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const query = args.query;
      if (typeof query !== "string" || query.trim() === "") {
        return { error: "query must be a non-empty string" };
      }

      const maxResults =
        typeof args.max_results === "number" && args.max_results > 0
          ? args.max_results
          : DEFAULT_MAX_RESULTS;

      const tools = getTools();
      const trimmed = query.trim();

      if (trimmed.startsWith("select:")) {
        const names = trimmed
          .slice(7)
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        return tools.filter((t) => names.includes(t.name));
      }

      const tokens = trimmed.toLowerCase().split(/\s+/);
      const scored: readonly { readonly tool: ToolSummary; readonly score: number }[] = tools
        .map((tool) => {
          const nameLower = tool.name.toLowerCase();
          const descLower = (tool.description ?? "").toLowerCase();
          let score = 0;
          for (const token of tokens) {
            if (nameLower.includes(token)) score += 2;
            if (descLower.includes(token)) score += 1;
          }
          return { tool, score } as const;
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

      return scored.slice(0, maxResults).map((entry) => entry.tool);
    },
  };
}
