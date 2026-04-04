/**
 * memory_search tool — search memories by keyword, type, or date range.
 *
 * All inputs are optional: an empty search returns all memories up to the limit.
 */

import type { JsonObject, KoiError, Result, Tool } from "@koi/core";
import { ALL_MEMORY_TYPES } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import { DEFAULT_PREFIX, DEFAULT_SEARCH_LIMIT } from "../constants.js";
import {
  parseOptionalEnum,
  parseOptionalNumber,
  parseOptionalString,
  parseOptionalTimestamp,
} from "../parse-args.js";
import type { MemorySearchFilter, MemoryToolBackend } from "../types.js";

/** Execute handler — extracted for size limit. */
async function executeSearch(
  args: JsonObject,
  backend: MemoryToolBackend,
  maxLimit: number,
): Promise<unknown> {
  const keywordResult = parseOptionalString(args, "keyword");
  if (!keywordResult.ok) return keywordResult.err;

  const typeResult = parseOptionalEnum(args, "type", ALL_MEMORY_TYPES);
  if (!typeResult.ok) return typeResult.err;

  const afterResult = parseOptionalTimestamp(args, "updated_after");
  if (!afterResult.ok) return afterResult.err;

  const beforeResult = parseOptionalTimestamp(args, "updated_before");
  if (!beforeResult.ok) return beforeResult.err;

  const limitResult = parseOptionalNumber(args, "limit");
  if (!limitResult.ok) return limitResult.err;

  const limit = Math.min(Math.max(1, limitResult.value ?? maxLimit), maxLimit);

  const filter: MemorySearchFilter = {
    ...(keywordResult.value !== undefined ? { keyword: keywordResult.value } : {}),
    ...(typeResult.value !== undefined ? { type: typeResult.value } : {}),
    ...(afterResult.value !== undefined ? { updatedAfter: afterResult.value } : {}),
    ...(beforeResult.value !== undefined ? { updatedBefore: beforeResult.value } : {}),
    limit,
  };

  try {
    const result = await backend.search(filter);
    if (!result.ok) return { error: result.error.message, code: "INTERNAL" };
    return { results: result.value, count: result.value.length };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
  }
}

/** Create the memory_search tool. */
export function createMemorySearchTool(
  backend: MemoryToolBackend,
  prefix: string = DEFAULT_PREFIX,
  searchLimit: number = DEFAULT_SEARCH_LIMIT,
): Result<Tool, KoiError> {
  return buildTool({
    name: `${prefix}_search`,
    description:
      "Search memories by keyword, type, or date range. " +
      "All inputs are optional — an empty search returns all memories.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Text to search in name, description, and content",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "Filter by memory type",
        },
        updated_after: {
          type: "string",
          description: "ISO 8601 timestamp — only memories updated after this time",
        },
        updated_before: {
          type: "string",
          description: "ISO 8601 timestamp — only memories updated before this time",
        },
        limit: { type: "number", description: `Max results (default: ${searchLimit})` },
      },
    },
    origin: "primordial",
    sandbox: false,
    execute: async (args: JsonObject): Promise<unknown> =>
      executeSearch(args, backend, searchLimit),
  });
}
