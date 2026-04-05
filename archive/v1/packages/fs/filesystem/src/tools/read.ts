/**
 * Tool factory for `fs_read` — reads file content via a FileSystemBackend.
 */

import type { FileReadOptions, FileSystemBackend, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalNumber, parseOptionalString, parseString } from "../parse-args.js";

export function createFsReadTool(
  backend: FileSystemBackend,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_read`,
      description: `Read file content. Backend: ${backend.name}`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file (relative to workspace root, e.g. 'src/index.ts')" },
          offset: { type: "number", description: "Line offset to start reading from" },
          limit: { type: "number", description: "Maximum number of lines to read" },
          encoding: { type: "string", description: "File encoding (default: utf-8)" },
        },
        required: ["path"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const pathResult = parseString(args, "path");
      if (!pathResult.ok) return pathResult.err;
      const offsetResult = parseOptionalNumber(args, "offset");
      if (!offsetResult.ok) return offsetResult.err;
      const limitResult = parseOptionalNumber(args, "limit");
      if (!limitResult.ok) return limitResult.err;
      const encodingResult = parseOptionalString(args, "encoding");
      if (!encodingResult.ok) return encodingResult.err;

      const options: FileReadOptions = {
        ...(offsetResult.value !== undefined && { offset: offsetResult.value }),
        ...(limitResult.value !== undefined && { limit: limitResult.value }),
        ...(encodingResult.value !== undefined && { encoding: encodingResult.value }),
      };
      const result = await backend.read(pathResult.value, options);
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
