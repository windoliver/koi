/**
 * Tool factory for `fs_semantic_search` — ranked semantic search over filesystem content.
 *
 * Delegates to a Retriever from @koi/search-provider. Only registered when the
 * caller supplies a retriever to createFileSystemProvider.
 */

import type { JsonObject, Tool, TrustTier } from "@koi/core";
import type { Retriever } from "@koi/search-provider";
import { parseOptionalNumber, parseString } from "../parse-args.js";

/** Default number of results returned when limit is not specified. */
export const DEFAULT_SEMANTIC_SEARCH_LIMIT = 10;

export function createFsSemanticSearchTool(
  retriever: Retriever,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_semantic_search`,
      description: "Semantic search over indexed files. Returns ranked results by relevance score.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query" },
          limit: {
            type: "number",
            description: `Maximum number of results to return (default: ${DEFAULT_SEMANTIC_SEARCH_LIMIT})`,
          },
          minScore: {
            type: "number",
            description: "Minimum relevance score threshold (0–1)",
          },
        },
        required: ["query"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const queryResult = parseString(args, "query");
      if (!queryResult.ok) return queryResult.err;

      const limitResult = parseOptionalNumber(args, "limit");
      if (!limitResult.ok) return limitResult.err;

      const minScoreResult = parseOptionalNumber(args, "minScore");
      if (!minScoreResult.ok) return minScoreResult.err;

      const result = await retriever.retrieve({
        text: queryResult.value,
        limit: limitResult.value ?? DEFAULT_SEMANTIC_SEARCH_LIMIT,
        ...(minScoreResult.value !== undefined && { minScore: minScoreResult.value }),
      });

      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
