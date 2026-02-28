/**
 * Tool factory for `registry_get` — get detailed info about a single brick.
 *
 * Routes to BrickRegistryReader.get(). Supports "summary" (default) and "full"
 * detail levels. Summary omits implementation, inputSchema, files, provenance, fitness.
 */

import type { BrickKind, JsonObject, RegistryComponent, Tool, TrustTier } from "@koi/core";
import { ALL_BRICK_KINDS } from "@koi/core";
import { parseEnum, parseOptionalEnum, parseString } from "../parse-args.js";
import { mapBrickFull, mapBrickSummary } from "./map-brick.js";

export function createRegistryGetTool(
  facade: RegistryComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_get`,
      description:
        "Get detailed information about a specific brick by kind and name. " +
        "Use detail='full' to include implementation code and schemas.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...ALL_BRICK_KINDS],
            description: "Brick kind (tool, skill, agent, middleware, channel)",
          },
          name: {
            type: "string",
            description: "Brick name",
          },
          detail: {
            type: "string",
            enum: ["summary", "full"],
            description:
              "Detail level: 'summary' (default) omits implementation; 'full' includes everything",
          },
        },
        required: ["kind", "name"],
      } as JsonObject,
    },
    trustTier,

    execute: async (args: JsonObject): Promise<unknown> => {
      const kindResult = parseEnum<BrickKind>(args, "kind", [...ALL_BRICK_KINDS]);
      if (!kindResult.ok) return kindResult.err;

      const nameResult = parseString(args, "name");
      if (!nameResult.ok) return nameResult.err;

      const detailResult = parseOptionalEnum(args, "detail", ["summary", "full"] as const);
      if (!detailResult.ok) return detailResult.err;

      const detail = detailResult.value ?? "summary";

      try {
        const result = await facade.bricks.get(kindResult.value, nameResult.value);
        if (!result.ok) {
          return { error: result.error.message, code: result.error.code };
        }

        return detail === "full" ? mapBrickFull(result.value) : mapBrickSummary(result.value);
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
