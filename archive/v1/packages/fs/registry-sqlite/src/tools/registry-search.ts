/**
 * Tool factory for `registry_search` — FTS5 search across bricks.
 *
 * Queries BrickRegistryReader with optional text, kind, tags, and cursor pagination.
 * Returns summaries (omits implementation, inputSchema, files, provenance, fitness).
 */

import type { BrickKind, JsonObject, RegistryComponent, Tool, ToolPolicy } from "@koi/core";
import { ALL_BRICK_KINDS } from "@koi/core";
import {
  parseOptionalEnum,
  parseOptionalNumber,
  parseOptionalString,
  parseOptionalStringArray,
} from "../parse-args.js";
import { mapBrickSummary } from "./map-brick.js";

export function createRegistrySearchTool(
  facade: RegistryComponent,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_search`,
      description:
        "Search the brick registry using FTS5 full-text search. " +
        "Supports filtering by kind, tags, and cursor-based pagination.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "FTS5 search query text. Omit to browse all bricks.",
          },
          kind: {
            type: "string",
            enum: [...ALL_BRICK_KINDS],
            description: "Filter by brick kind",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags (AND — all must match)",
          },
          limit: {
            type: "number",
            description: "Max results per page (default: 20, max: 50)",
          },
          cursor: {
            type: "string",
            description: "Opaque cursor for the next page",
          },
        },
        required: [],
      } as JsonObject,
    },
    origin: "primordial",
    policy,

    execute: async (args: JsonObject): Promise<unknown> => {
      const textResult = parseOptionalString(args, "text");
      if (!textResult.ok) return textResult.err;

      const kindResult = parseOptionalEnum<BrickKind>(args, "kind", [...ALL_BRICK_KINDS]);
      if (!kindResult.ok) return kindResult.err;

      const tagsResult = parseOptionalStringArray(args, "tags");
      if (!tagsResult.ok) return tagsResult.err;

      const limitResult = parseOptionalNumber(args, "limit");
      if (!limitResult.ok) return limitResult.err;

      const cursorResult = parseOptionalString(args, "cursor");
      if (!cursorResult.ok) return cursorResult.err;

      const requestedLimit = limitResult.value ?? 20;
      const clampedLimit = Math.min(Math.max(1, requestedLimit), 50);

      try {
        const page = await facade.bricks.search({
          ...(textResult.value !== undefined ? { text: textResult.value } : {}),
          ...(kindResult.value !== undefined ? { kind: kindResult.value } : {}),
          ...(tagsResult.value !== undefined ? { tags: tagsResult.value } : {}),
          limit: clampedLimit,
          ...(cursorResult.value !== undefined ? { cursor: cursorResult.value } : {}),
        });

        return {
          items: page.items.map(mapBrickSummary),
          ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
          ...(page.total !== undefined ? { total: page.total } : {}),
        };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
