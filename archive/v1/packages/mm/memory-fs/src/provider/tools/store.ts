/**
 * Tool factory for `memory_store` — persist an atomic fact to long-term memory.
 */

import type { JsonObject, MemoryComponent, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalString, parseOptionalStringArray, parseString } from "../parse-args.js";

export function createMemoryStoreTool(
  component: MemoryComponent,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_store`,
      description:
        "Store an atomic fact in long-term memory. Include category and related entities for cross-referencing.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact to store (one atomic fact per call)",
          },
          category: {
            type: "string",
            description:
              'Category for the fact (e.g. "preference", "relationship", "decision", "milestone", "correction")',
          },
          related_entities: {
            type: "array",
            items: { type: "string" },
            description: "People, projects, or concepts this fact relates to",
          },
          causal_parents: {
            type: "array",
            items: { type: "string" },
            description: "IDs of existing memory facts that causally precede this one",
          },
        },
        required: ["content"],
      } satisfies JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const contentResult = parseString(args, "content");
      if (!contentResult.ok) return contentResult.err;

      const categoryResult = parseOptionalString(args, "category");
      if (!categoryResult.ok) return categoryResult.err;

      const entitiesResult = parseOptionalStringArray(args, "related_entities");
      if (!entitiesResult.ok) return entitiesResult.err;

      const causalParentsResult = parseOptionalStringArray(args, "causal_parents");
      if (!causalParentsResult.ok) return causalParentsResult.err;

      try {
        await component.store(contentResult.value, {
          ...(categoryResult.value !== undefined && { category: categoryResult.value }),
          ...(entitiesResult.value !== undefined && { relatedEntities: entitiesResult.value }),
          ...(causalParentsResult.value !== undefined && {
            causalParents: causalParentsResult.value,
          }),
        });
        return { stored: true };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
