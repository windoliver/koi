/**
 * memory_recall tool — retrieve memories relevant to a query or topic.
 *
 * Supports limit clamping, tier filtering, and optional graph expansion
 * over causal edges.
 */

import type { JsonObject, KoiError, Result, Tool } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import { DEFAULT_PREFIX, DEFAULT_RECALL_LIMIT, validateMemoryDir } from "../constants.js";
import {
  parseOptionalBoolean,
  parseOptionalEnum,
  parseOptionalInteger,
  parseString,
} from "../parse-args.js";
import { safeBackendError, safeCatchError } from "../safe-error.js";
import type { MemoryToolBackend, MemoryToolRecallOptions } from "../types.js";

const TIER_VALUES = ["hot", "warm", "cold", "all"] as const;

/** Execute handler — extracted for size limit. */
async function executeRecall(
  args: JsonObject,
  backend: MemoryToolBackend,
  maxLimit: number,
): Promise<unknown> {
  const queryResult = parseString(args, "query");
  if (!queryResult.ok) return queryResult.err;

  const limitResult = parseOptionalInteger(args, "limit");
  if (!limitResult.ok) return limitResult.err;

  const tierResult = parseOptionalEnum(args, "tier", TIER_VALUES);
  if (!tierResult.ok) return tierResult.err;

  const expandResult = parseOptionalBoolean(args, "graph_expand");
  if (!expandResult.ok) return expandResult.err;

  const hopsResult = parseOptionalInteger(args, "max_hops");
  if (!hopsResult.ok) return hopsResult.err;

  if (hopsResult.value !== undefined && hopsResult.value < 0) {
    return { error: "max_hops must be a non-negative integer", code: "VALIDATION" };
  }

  const limit = Math.min(Math.max(1, limitResult.value ?? maxLimit), maxLimit);

  const graphExpand = expandResult.value ?? false;

  const options: MemoryToolRecallOptions = {
    limit,
    tierFilter: tierResult.value ?? "all",
    graphExpand,
    ...(graphExpand ? { maxHops: hopsResult.value ?? 2 } : {}),
  };

  try {
    const result = await backend.recall(queryResult.value, options);
    if (!result.ok) return safeBackendError(result.error, "Failed to recall memories");
    // Strip filePath — internal implementation detail, not useful to the model (#1725)
    const results = result.value.map(({ filePath: _, ...rest }) => rest);
    return { results, count: results.length };
  } catch {
    return safeCatchError("Failed to recall memories");
  }
}

/** Create the memory_recall tool. */
export function createMemoryRecallTool(
  backend: MemoryToolBackend,
  memoryDir: string,
  prefix: string = DEFAULT_PREFIX,
  recallLimit: number = DEFAULT_RECALL_LIMIT,
): Result<Tool, KoiError> {
  const dirValidation = validateMemoryDir(memoryDir);
  if (!dirValidation.ok) return dirValidation;

  if (!Number.isInteger(recallLimit) || recallLimit < 1) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "recallLimit must be a positive integer",
        retryable: false,
      },
    };
  }

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
    sandbox: true,
    filesystem: { read: [memoryDir] },
    execute: async (args: JsonObject): Promise<unknown> =>
      executeRecall(args, backend, recallLimit),
  });
}
