/**
 * Tool factory for `fs_search` — searches file content via a FileSystemBackend.
 */

import type { FileSearchOptions, FileSystemBackend, JsonObject, Tool, TrustTier } from "@koi/core";
import {
  parseOptionalBoolean,
  parseOptionalNumber,
  parseOptionalString,
  parseString,
} from "../parse-args.js";

export function createFsSearchTool(
  backend: FileSystemBackend,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_search`,
      description: `Search file contents by pattern. Backend: ${backend.name}`,
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex supported)" },
          glob: {
            type: "string",
            description: "Glob pattern to filter files (e.g. '**/*.ts')",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matches to return",
          },
          caseSensitive: {
            type: "boolean",
            description: "Case-sensitive search (default: true)",
          },
        },
        required: ["pattern"],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const patternResult = parseString(args, "pattern");
      if (!patternResult.ok) return patternResult.err;
      const globResult = parseOptionalString(args, "glob");
      if (!globResult.ok) return globResult.err;
      const maxResultsResult = parseOptionalNumber(args, "maxResults");
      if (!maxResultsResult.ok) return maxResultsResult.err;
      const caseSensitiveResult = parseOptionalBoolean(args, "caseSensitive");
      if (!caseSensitiveResult.ok) return caseSensitiveResult.err;

      const options: FileSearchOptions = {
        ...(globResult.value !== undefined && { glob: globResult.value }),
        ...(maxResultsResult.value !== undefined && { maxResults: maxResultsResult.value }),
        ...(caseSensitiveResult.value !== undefined && {
          caseSensitive: caseSensitiveResult.value,
        }),
      };
      const result = await backend.search(patternResult.value, options);
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
