/**
 * Tool factory for `registry_list_versions` — list version history for a brick.
 *
 * Queries VersionIndexReader.listVersions() and returns all versions sorted
 * by publishedAt DESC.
 */

import type {
  BrickKind,
  JsonObject,
  RegistryComponent,
  Tool,
  TrustTier,
  VersionEntry,
} from "@koi/core";
import { ALL_BRICK_KINDS } from "@koi/core";
import { parseEnum, parseString } from "../parse-args.js";

export function createRegistryListVersionsTool(
  facade: RegistryComponent,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_list_versions`,
      description:
        "List all published versions of a brick, newest first. " +
        "Includes version labels, publish dates, and deprecation status.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Brick name",
          },
          kind: {
            type: "string",
            enum: [...ALL_BRICK_KINDS],
            description: "Brick kind (tool, skill, agent, middleware, channel)",
          },
        },
        required: ["name", "kind"],
      } as JsonObject,
    },
    trustTier,

    execute: async (args: JsonObject): Promise<unknown> => {
      const nameResult = parseString(args, "name");
      if (!nameResult.ok) return nameResult.err;

      const kindResult = parseEnum<BrickKind>(args, "kind", [...ALL_BRICK_KINDS]);
      if (!kindResult.ok) return kindResult.err;

      try {
        const result = await facade.versions.listVersions(nameResult.value, kindResult.value);
        if (!result.ok) {
          return { error: result.error.message, code: result.error.code };
        }

        return {
          versions: result.value.map((v: VersionEntry) => ({
            version: v.version,
            brickId: v.brickId,
            publisher: v.publisher,
            publishedAt: v.publishedAt,
            ...(v.deprecated === true ? { deprecated: true } : {}),
          })),
          count: result.value.length,
        };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
