/**
 * Tool factory for scratchpad_write — write a file to the shared scratchpad.
 */

import type { JsonObject, ScratchpadComponent, Tool, ToolPolicy } from "@koi/core";
import { scratchpadPath } from "@koi/core";

export function createWriteTool(
  component: ScratchpadComponent,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_write`,
      description:
        "Write a file to the shared scratchpad. Supports CAS concurrency control via expectedGeneration.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (no '..' or leading '/')" },
          content: { type: "string", description: "File content" },
          expectedGeneration: {
            type: "number",
            description: "CAS: 0=create-only, omit=unconditional, >0=update if matches",
          },
          ttlSeconds: { type: "number", description: "Optional TTL in seconds" },
          metadata: { type: "object", description: "Optional metadata" },
        },
        required: ["path", "content"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const path = args.path;
      const content = args.content;

      if (typeof path !== "string" || typeof content !== "string") {
        return { error: "path and content must be strings", code: "VALIDATION" };
      }

      const result = await component.write({
        path: scratchpadPath(path),
        content,
        ...(typeof args.expectedGeneration === "number"
          ? { expectedGeneration: args.expectedGeneration }
          : {}),
        ...(typeof args.ttlSeconds === "number" ? { ttlSeconds: args.ttlSeconds } : {}),
        ...(typeof args.metadata === "object" && args.metadata !== null
          ? { metadata: args.metadata as JsonObject }
          : {}),
      });

      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }

      return result.value;
    },
  };
}
