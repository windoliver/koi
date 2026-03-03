/**
 * Tool factory for scratchpad_list — list files in the shared scratchpad.
 */

import type { JsonObject, ScratchpadComponent, Tool, TrustTier } from "@koi/core";
import { agentId } from "@koi/core";

export function createListTool(
  component: ScratchpadComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_list`,
      description: "List files in the shared scratchpad with optional filtering.",
      inputSchema: {
        type: "object",
        properties: {
          glob: { type: "string", description: "Optional glob pattern to filter paths" },
          authorId: { type: "string", description: "Optional author ID to filter by" },
          limit: { type: "number", description: "Maximum number of entries to return" },
        },
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const entries = await component.list({
        ...(typeof args.glob === "string" ? { glob: args.glob } : {}),
        ...(typeof args.authorId === "string" ? { authorId: agentId(args.authorId) } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });

      return { entries, count: entries.length };
    },
  };
}
