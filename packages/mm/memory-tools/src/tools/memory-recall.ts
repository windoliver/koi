/**
 * memory_recall tool — retrieve memories relevant to a query or topic.
 *
 * Supports limit clamping, tier filtering, and optional graph expansion
 * over causal edges.
 */

import type { JsonObject, KoiError, Result, Tool } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import { DEFAULT_PREFIX, DEFAULT_RECALL_LIMIT } from "../constants.js";
import {
  parseOptionalBoolean,
  parseOptionalEnum,
  parseOptionalNumber,
  parseString,
} from "../parse-args.js";
import { safeBackendError, safeCatchError } from "../safe-error.js";
import type { MemoryToolBackend, MemoryToolRecallOptions } from "../types.js";

const TIER_VALUES = ["hot", "warm", "cold", "all"] as const;

/** Clamp and round a numeric value to a positive integer within [1, max]. */
function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(1, Math.round(value ?? fallback)), max);
}

/** Execute handler — extracted for size limit. */
async function executeRecall(
  args: JsonObject,
  backend: MemoryToolBackend,
  maxLimit: number,
): Promise<unknown> {
  const queryResult = parseString(args, "query");
  if (!queryResult.ok) return queryResult.err;

  const limitResult = parseOptionalNumber(args, "limit");
  if (!limitResult.ok) return limitResult.err;

  const tierResult = parseOptionalEnum(args, "tier", TIER_VALUES);
  if (!tierResult.ok) return tierResult.err;

  const expandResult = parseOptionalBoolean(args, "graph_expand");
  if (!expandResult.ok) return expandResult.err;

  const hopsResult = parseOptionalNumber(args, "max_hops");
  if (!hopsResult.ok) return hopsResult.err;

  if (hopsResult.value !== undefined && hopsResult.value < 0) {
    return { error: "max_hops must be a non-negative integer", code: "VALIDATION" };
  }

  const limit = clampPositiveInt(limitResult.value, maxLimit, maxLimit);

  const options: MemoryToolRecallOptions = {
    limit,
    tierFilter: tierResult.value ?? "all",
    graphExpand: expandResult.value ?? false,
    maxHops: hopsResult.value !== undefined ? Math.round(hopsResult.value) : 2,
  };

  try {
    const result = await backend.recall(queryResult.value, options);
    if (!result.ok) return safeBackendError(result.error, "Failed to recall memories");
    return { results: result.value, count: result.value.length };
  } catch {
    return safeCatchError("Failed to recall memories");
  }
}

/** Create the memory_recall tool. */
export function createMemoryRecallTool(
  backend: MemoryToolBackend,
  prefix: string = DEFAULT_PREFIX,
  recallLimit: number = DEFAULT_RECALL_LIMIT,
): Result<Tool, KoiError> {
  return buildTool({
    name: `${prefix}_recall`,
    description:
      "Retrieve memories relevant to a query or topic. " +
      "Returns matching memories ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Semantic search query" },
        limit: { type: "integer", description: `Max results (default: ${recallLimit})` },
        tier: {
          type: "string",
          enum: ["hot", "warm", "cold", "all"],
          description: "Filter by memory tier (default: all)",
        },
        graph_expand: {
          type: "boolean",
          description: "Expand results along causal edges",
        },
        max_hops: {
          type: "integer",
          description: "Max BFS hops for graph expansion (default: 2)",
        },
      },
      required: ["query"],
    },
    origin: "primordial",
    sandbox: false,
    execute: async (args: JsonObject): Promise<unknown> =>
      executeRecall(args, backend, recallLimit),
  });
}
