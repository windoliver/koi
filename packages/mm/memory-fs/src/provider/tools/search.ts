/**
 * Tool factory for `memory_search` — browse memories by entity.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import type { FsMemory } from "../../types.js";
import { DEFAULT_SEARCH_LIMIT } from "../constants.js";
import { parseOptionalNumber, parseOptionalString } from "../parse-args.js";

export function createMemorySearchTool(
  memory: FsMemory,
  prefix: string,
  policy: ToolPolicy,
  searchLimit: number = DEFAULT_SEARCH_LIMIT,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_search`,
      description: "Browse what you know about a specific entity, or list all known entities.",
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description:
              "Name of the person, project, or concept to look up. Omit to list all known entities.",
          },
          limit: {
            type: "number",
            description: `Max results when searching by entity (default: ${searchLimit})`,
          },
        },
        required: [],
      } satisfies JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const entityResult = parseOptionalString(args, "entity");
      if (!entityResult.ok) return entityResult.err;

      const limitResult = parseOptionalNumber(args, "limit");
      if (!limitResult.ok) return limitResult.err;

      const clampedLimit = Math.min(Math.max(1, limitResult.value ?? searchLimit), searchLimit);

      try {
        if (entityResult.value !== undefined) {
          const results = await memory.component.recall(entityResult.value, {
            limit: clampedLimit,
          });
          return { results, count: results.length };
        }

        const entities = await memory.listEntities();
        return { entities };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
