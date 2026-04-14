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
import type { FsToolOptions } from "./read.js";

export function createFsWriteTool(
  backend: FileSystemBackend,
  prefix: string,
  policy: ToolPolicy,
  fsToolOptions?: FsToolOptions,
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
            description:
              "Overwrite existing file (default: false — fails if file exists unless set to true)",
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

      if (fsToolOptions?.pathGuard !== undefined) {
        const guardResult = fsToolOptions.pathGuard(pathResult.value);
        if (!guardResult.ok) {
          return { error: guardResult.reason, code: "CREDENTIAL_PATH_DENIED" };
        }
      }

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
        overwrite: overwriteResult.value ?? false,
        ...(createDirsResult.value !== undefined && { createDirectories: createDirsResult.value }),
      };
      const result = await backend.write(pathResult.value, contentResult.value, options);
      // No post-write cancellation check: if the backend committed, report
      // the real outcome so callers don't retry an already-applied write.
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      if (result.value.resolvedPath !== undefined) {
        return {
          ...result.value,
          note: `Path coerced to workspace-relative: "${result.value.resolvedPath}". File is inside the workspace, not at the absolute host path "${pathResult.value}".`,
        };
      }
      return result.value;
    },
  };
}
