/**
 * Tool factory for scratchpad_delete — delete a file from the shared scratchpad.
 */

import type { JsonObject, ScratchpadComponent, Tool, TrustTier } from "@koi/core";
import { scratchpadPath } from "@koi/core";

export function createDeleteTool(
  component: ScratchpadComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_delete`,
      description: "Delete a file from the shared scratchpad.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to delete" },
        },
        required: ["path"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const path = args.path;

      if (typeof path !== "string") {
        return { error: "path must be a string", code: "VALIDATION" };
      }

      const result = await component.delete(scratchpadPath(path));

      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }

      return { deleted: true, path };
    },
  };
}
