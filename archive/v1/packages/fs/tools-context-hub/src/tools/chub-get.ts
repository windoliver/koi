/**
 * Tool factory for `chub_get` — fetch a specific doc from Context Hub.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import type { ContextHubExecutor } from "../context-hub-executor.js";

export function createChubGetTool(
  executor: ContextHubExecutor,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_get`,
      description:
        "Fetch a specific API documentation page from Context Hub by ID. " +
        "Returns the full markdown content. Specify a language variant if multiple are available. " +
        "Use chub_search first to find doc IDs.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Doc ID from search results (e.g., 'stripe/payments', 'openai/chat')",
          },
          language: {
            type: "string",
            description:
              "Language variant (e.g., 'javascript', 'python'). Required when multiple variants exist.",
          },
          version: {
            type: "string",
            description: "Specific version (e.g., '2.0.0'). Defaults to the recommended version.",
          },
        },
        required: ["id"],
      } satisfies JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      // Validate id
      if (typeof args.id !== "string" || args.id.trim() === "") {
        return { error: "id must be a non-empty string", code: "VALIDATION" };
      }

      // Validate language (optional)
      const language =
        typeof args.language === "string" && args.language.trim() !== ""
          ? args.language.trim()
          : undefined;

      // Validate version (optional)
      const version =
        typeof args.version === "string" && args.version.trim() !== ""
          ? args.version.trim()
          : undefined;

      const result = await executor.get(args.id.trim(), language, version);

      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }

      return {
        id: result.value.id,
        language: result.value.language,
        version: result.value.version,
        content: result.value.content,
        truncated: result.value.truncated,
      };
    },
  };
}
