/**
 * Tool factory for `memory_recall` — search memories by semantic query.
 */

import type { JsonObject, MemoryComponent, Tool, TrustTier } from "@koi/core";
import { DEFAULT_RECALL_LIMIT } from "../constants.js";
import { parseOptionalEnum, parseOptionalNumber, parseString } from "../parse-args.js";

export function createMemoryRecallTool(
  component: MemoryComponent,
  prefix: string,
  trustTier: TrustTier,
  recallLimit: number = DEFAULT_RECALL_LIMIT,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_recall`,
      description: `Search memories by meaning. Returns up to ${recallLimit} results ranked by relevance.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Semantic search query to find relevant memories",
          },
          limit: {
            type: "number",
            description: `Max results to return (default: ${recallLimit})`,
          },
          tier: {
            type: "string",
            enum: ["hot", "warm", "cold", "all"],
            description: 'Filter by memory tier (default: "all")',
          },
        },
        required: ["query"],
      } satisfies JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const queryResult = parseString(args, "query");
      if (!queryResult.ok) return queryResult.err;

      const limitResult = parseOptionalNumber(args, "limit");
      if (!limitResult.ok) return limitResult.err;

      const tierResult = parseOptionalEnum(args, "tier", ["hot", "warm", "cold", "all"] as const);
      if (!tierResult.ok) return tierResult.err;

      const clampedLimit = Math.min(Math.max(1, limitResult.value ?? recallLimit), recallLimit);

      try {
        const results = await component.recall(queryResult.value, {
          limit: clampedLimit,
          ...(tierResult.value !== undefined && { tierFilter: tierResult.value }),
        });
        return { results, count: results.length };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
