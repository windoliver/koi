/**
 * Tool factory for `fs_list` — lists directory contents via a FileSystemBackend.
 */

import type { FileListOptions, FileSystemBackend, JsonObject, Tool, ToolPolicy } from "@koi/core";
import { parseOptionalBoolean, parseOptionalString, parseString } from "../parse-args.js";

export function createFsListTool(
  backend: FileSystemBackend,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_list`,
      description: `List directory contents. Backend: ${backend.name}`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the directory" },
          recursive: {
            type: "boolean",
            description: "Recurse into subdirectories (default: false)",
          },
          glob: {
            type: "string",
            description: "Glob pattern to filter entries (e.g. '*.ts')",
          },
        },
        required: ["path"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      const pathResult = parseString(args, "path");
      if (!pathResult.ok) return pathResult.err;
      const recursiveResult = parseOptionalBoolean(args, "recursive");
      if (!recursiveResult.ok) return recursiveResult.err;
      const globResult = parseOptionalString(args, "glob");
      if (!globResult.ok) return globResult.err;

      const options: FileListOptions = {
        ...(recursiveResult.value !== undefined && { recursive: recursiveResult.value }),
        ...(globResult.value !== undefined && { glob: globResult.value }),
      };
      const result = await backend.list(pathResult.value, options);
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
