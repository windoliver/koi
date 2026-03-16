/**
 * Tool factory for `chub_search` — search Context Hub for API documentation.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import type { ContextHubExecutor } from "../context-hub-executor.js";
import { DEFAULT_MAX_SEARCH_RESULTS } from "../context-hub-executor.js";

const MAX_MAX_RESULTS = 20;

export function createChubSearchTool(
  executor: ContextHubExecutor,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_search`,
      description:
        "Search Context Hub for curated API documentation. Returns ranked results " +
        "with metadata including available languages, quality source, and doc size. " +
        "Use this to find accurate, up-to-date API docs before writing integration code.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (e.g., 'stripe payments', 'openai chat completions')",
          },
          max_results: {
            type: "number",
            description: `Maximum results to return (default: ${DEFAULT_MAX_SEARCH_RESULTS}, max: ${MAX_MAX_RESULTS})`,
          },
        },
        required: ["query"],
      } satisfies JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      // Validate query
      if (typeof args.query !== "string" || args.query.trim() === "") {
        return { error: "query must be a non-empty string", code: "VALIDATION" };
      }

      // Validate max_results
      const maxResults =
        typeof args.max_results === "number"
          ? Math.min(Math.max(1, Math.floor(args.max_results)), MAX_MAX_RESULTS)
          : DEFAULT_MAX_SEARCH_RESULTS;

      const result = await executor.search(args.query.trim(), maxResults);

      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }

      if (result.value.length === 0) {
        return {
          query: args.query.trim(),
          results: [],
          count: 0,
          hint: "No matching docs found. Try broader search terms, or check available docs with a general query like 'api'.",
        };
      }

      return {
        query: args.query.trim(),
        results: result.value,
        count: result.value.length,
      };
    },
  };
}
