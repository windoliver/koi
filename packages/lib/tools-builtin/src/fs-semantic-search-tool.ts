import type { JsonObject, Tool, ToolExecuteOptions, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

export interface SemanticSearchHit {
  readonly path: string;
  readonly snippet: string;
  readonly score: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface SemanticSearchResponse {
  readonly results: readonly SemanticSearchHit[];
  readonly warning?: string | undefined;
}

export type SemanticSearchFn = (
  query: string,
  options?: {
    readonly scope?: string;
    readonly maxResults?: number;
    readonly minScore?: number;
  },
) => Promise<
  { readonly ok: true; readonly value: SemanticSearchResponse } | { readonly ok: false }
>;

export interface FsSemanticSearchToolConfig {
  readonly search: SemanticSearchFn;
  readonly policy?: ToolPolicy;
}

export function createFsSemanticSearchTool(config: FsSemanticSearchToolConfig): Tool {
  const { search, policy = DEFAULT_UNSANDBOXED_POLICY } = config;

  return {
    descriptor: {
      name: "fs_semantic_search",
      description:
        "Search files by meaning. Use when you need to find code by intent rather than exact pattern.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language description of what to find",
          },
          scope: {
            type: "string",
            description: "Optional glob to narrow search scope",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of semantic results to return",
          },
          minScore: {
            type: "number",
            description: "Minimum relevance score to include",
          },
        },
        required: ["query"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject, _options?: ToolExecuteOptions): Promise<unknown> => {
      const query = args.query;
      if (typeof query !== "string" || query.trim() === "") {
        return { error: "query must be a non-empty string" };
      }

      const result = await search(query.trim(), {
        ...(typeof args.scope === "string" && args.scope.length > 0 ? { scope: args.scope } : {}),
        ...(typeof args.maxResults === "number" ? { maxResults: args.maxResults } : {}),
        ...(typeof args.minScore === "number" ? { minScore: args.minScore } : {}),
      });
      if (!result.ok) {
        return { error: "Semantic search failed" };
      }
      return result.value;
    },
  };
}
