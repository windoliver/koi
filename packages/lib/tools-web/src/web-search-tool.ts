/**
 * Tool factory for `web_search` — search the web via injectable backend.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import type { WebExecutor } from "./web-executor.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 20;

export function createWebSearchTool(
  executor: WebExecutor,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_search`,
      description:
        "Search the web for information. Returns a list of results with title, URL, and snippet. " +
        "Requires a search backend to be configured in the executor.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: {
            type: "number",
            description: `Maximum number of results (default: ${DEFAULT_MAX_RESULTS}, max: ${MAX_MAX_RESULTS})`,
          },
        },
        required: ["query"],
      } satisfies JsonObject,
      origin: "primordial",
      ...(executor.providerName !== undefined ? { server: executor.providerName } : {}),
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      if (typeof args.query !== "string" || args.query.trim() === "") {
        return { error: "query must be a non-empty string", code: "VALIDATION" };
      }
      const maxResults =
        typeof args.max_results === "number"
          ? Math.min(Math.max(1, Math.floor(args.max_results)), MAX_MAX_RESULTS)
          : DEFAULT_MAX_RESULTS;

      const result = await executor.search(args.query.trim(), { maxResults });
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return {
        query: args.query.trim(),
        provider: executor.providerName ?? "unknown",
        results: result.value.slice(0, maxResults),
        count: Math.min(result.value.length, maxResults),
      };
    },
  };
}
