/**
 * Tool factory for `{prefix}_read` — reads file content via a FileSystemBackend.
 */

import type {
  FileReadOptions,
  FileSystemBackend,
  JsonObject,
  Tool,
  ToolExecuteOptions,
  ToolPolicy,
} from "@koi/core";
import type { PathGuardResult } from "../credential-path-guard.js";
import { parseOptionalNumber, parseOptionalString, parseString } from "../parse-args.js";

/** Options for filesystem tool factories. */
export interface FsToolOptions {
  /** Optional path guard for credential directory protection. */
  readonly pathGuard?: ((resolvedPath: string) => PathGuardResult) | undefined;
}

export function createFsReadTool(
  backend: FileSystemBackend,
  prefix: string,
  policy: ToolPolicy,
  fsToolOptions?: FsToolOptions,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_read`,
      description: `Read file content. Backend: ${backend.name}`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file (relative to workspace root, e.g. 'src/index.ts')",
          },
          offset: { type: "number", description: "Line offset to start reading from" },
          limit: { type: "number", description: "Maximum number of lines to read" },
          encoding: { type: "string", description: "File encoding (default: utf-8)" },
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

      if (fsToolOptions?.pathGuard !== undefined) {
        const guardResult = fsToolOptions.pathGuard(pathResult.value);
        if (!guardResult.ok) {
          return { error: guardResult.reason, code: "CREDENTIAL_PATH_DENIED" };
        }
      }

      const offsetResult = parseOptionalNumber(args, "offset", { nonNegativeInteger: true });
      if (!offsetResult.ok) return offsetResult.err;
      const limitResult = parseOptionalNumber(args, "limit", { nonNegativeInteger: true });
      if (!limitResult.ok) return limitResult.err;
      const encodingResult = parseOptionalString(args, "encoding");
      if (!encodingResult.ok) return encodingResult.err;

      const options: FileReadOptions = {
        ...(offsetResult.value !== undefined && { offset: offsetResult.value }),
        ...(limitResult.value !== undefined && { limit: limitResult.value }),
        ...(encodingResult.value !== undefined && { encoding: encodingResult.value }),
      };
      const result = await backend.read(pathResult.value, options);
      if (execOptions?.signal?.aborted) {
        return { error: "Operation cancelled", code: "CANCELLED" };
      }
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      if (result.value.resolvedPath !== undefined) {
        return {
          ...result.value,
          note: `Path coerced to workspace-relative: "${result.value.resolvedPath}". Reading from workspace sandbox, not the absolute host path "${pathResult.value}".`,
        };
      }
      return result.value;
    },
  };
}
