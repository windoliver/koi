/**
 * memory_recall tool — retrieve memories relevant to a query or topic.
 *
 * Supports limit clamping, tier filtering, and optional graph expansion
 * over causal edges.
 */

import type { JsonObject, KoiError, Result, Tool, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import { DEFAULT_PREFIX, DEFAULT_RECALL_LIMIT } from "../constants.js";
import {
  parseOptionalBoolean,
  parseOptionalEnum,
  parseOptionalNumber,
  parseString,
} from "../parse-args.js";
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

  const limitResult = parseOptionalNumber(args, "limit");
  if (!limitResult.ok) return limitResult.err;

  const tierResult = parseOptionalEnum(args, "tier", TIER_VALUES);
  if (!tierResult.ok) return tierResult.err;

  const expandResult = parseOptionalBoolean(args, "graph_expand");
  if (!expandResult.ok) return expandResult.err;

  const hopsResult = parseOptionalNumber(args, "max_hops");
  if (!hopsResult.ok) return hopsResult.err;

  const limit = Math.min(Math.max(1, limitResult.value ?? maxLimit), maxLimit);

  const options: MemoryToolRecallOptions = {
    limit,
    ...(tierResult.value !== undefined ? { tierFilter: tierResult.value } : {}),
    ...(expandResult.value !== undefined ? { graphExpand: expandResult.value } : {}),
    ...(hopsResult.value !== undefined ? { maxHops: hopsResult.value } : {}),
  };

  try {
    const result = await backend.recall(queryResult.value, options);
    if (!result.ok) return { error: result.error.message, code: "INTERNAL" };
    return { results: result.value, count: result.value.length };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
  }
}

/** Create the memory_recall tool. */
export function createMemoryRecallTool(
  backend: MemoryToolBackend,
  prefix: string = DEFAULT_PREFIX,
  _policy: ToolPolicy = DEFAULT_UNSANDBOXED_POLICY,
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
        limit: { type: "number", description: `Max results (default: ${recallLimit})` },
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
          type: "number",
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
