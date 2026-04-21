/**
 * Tool factory for `{prefix}_list` — lists directory entries via a FileSystemBackend.
 *
 * Needed for discovering mount namespaces when the backend is a multi-mount
 * router (`list("/")` returns one entry per mount). Also useful as a directory
 * listing primitive for any FileSystemBackend that implements it.
 */

import type {
  FileListOptions,
  FileSystemBackend,
  JsonObject,
  Tool,
  ToolExecuteOptions,
  ToolPolicy,
} from "@koi/core";
import { parseOptionalString, parseString } from "../parse-args.js";

export function createFsListTool(
  backend: FileSystemBackend,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_list`,
      description:
        `List directory entries. Backend: ${backend.name}. ` +
        `Pass path='/' to discover top-level mounts when using a multi-mount Nexus backend.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path. Use '/' to discover mount namespaces in multi-mount configs.",
          },
          recursive: {
            type: "boolean",
            description: "Walk subdirectories recursively (default: false)",
          },
          glob: {
            type: "string",
            description: "Filter entries by glob pattern (e.g. '*.ts')",
          },
        },
        required: ["path"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject, execOptions?: ToolExecuteOptions): Promise<unknown> => {
      if (execOptions?.signal?.aborted) {
        return { error: "Operation cancelled", code: "CANCELLED" };
      }

      const pathResult = parseString(args, "path");
      if (!pathResult.ok) return pathResult.err;

      const recursive = typeof args.recursive === "boolean" ? args.recursive : undefined;

      const globResult = parseOptionalString(args, "glob");
      if (!globResult.ok) return globResult.err;

      const options: FileListOptions = {
        ...(recursive !== undefined && { recursive }),
        ...(globResult.value !== undefined && { glob: globResult.value }),
      };

      const result = await backend.list(pathResult.value, options);
      if (execOptions?.signal?.aborted) {
        return { error: "Operation cancelled", code: "CANCELLED" };
      }
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
