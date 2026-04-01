/**
 * Tool factory for `{prefix}_write` — writes content to a file via a FileSystemBackend.
 */

import type {
  FileSystemBackend,
  FileWriteOptions,
  JsonObject,
  Tool,
  ToolExecuteOptions,
  ToolPolicy,
} from "@koi/core";
import { parseOptionalBoolean, parseString } from "../parse-args.js";

export function createFsWriteTool(
  backend: FileSystemBackend,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_write`,
      description: `Write content to a file. Backend: ${backend.name}`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          content: { type: "string", description: "Content to write" },
          createDirectories: {
            type: "boolean",
            description: "Create parent directories if missing (default: false)",
          },
          overwrite: {
            type: "boolean",
            description: "Overwrite existing file (default: true)",
          },
        },
        required: ["path", "content"],
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
      const contentResult = parseString(args, "content", { allowEmpty: true });
      if (!contentResult.ok) return contentResult.err;
      const createDirsResult = parseOptionalBoolean(args, "createDirectories");
      if (!createDirsResult.ok) return createDirsResult.err;
      const overwriteResult = parseOptionalBoolean(args, "overwrite");
      if (!overwriteResult.ok) return overwriteResult.err;

      if (execOptions?.signal?.aborted) {
        return { error: "Operation cancelled", code: "CANCELLED" };
      }

      const options: FileWriteOptions = {
        ...(createDirsResult.value !== undefined && { createDirectories: createDirsResult.value }),
        ...(overwriteResult.value !== undefined && { overwrite: overwriteResult.value }),
      };
      const result = await backend.write(pathResult.value, contentResult.value, options);
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
