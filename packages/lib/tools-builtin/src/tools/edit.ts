/**
 * Tool factory for `{prefix}_edit` — applies text edits to a file via a FileSystemBackend.
 */

import type {
  FileEdit,
  FileEditOptions,
  FileSystemBackend,
  JsonObject,
  Tool,
  ToolExecuteOptions,
  ToolPolicy,
} from "@koi/core";
import { parseArray, parseOptionalBoolean, parseString } from "../parse-args.js";

export function createFsEditTool(
  backend: FileSystemBackend,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_edit`,
      description: `Apply text edits (search-and-replace hunks) to a file. Backend: ${backend.name}`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          edits: {
            type: "array",
            description: "Array of { oldText, newText } replacement hunks",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Text to find" },
                newText: { type: "string", description: "Replacement text" },
              },
              required: ["oldText", "newText"],
            },
          },
          dryRun: {
            type: "boolean",
            description: "If true, report what would change without writing (default: false)",
          },
        },
        required: ["path", "edits"],
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
      const editsResult = parseArray(args, "edits");
      if (!editsResult.ok) return editsResult.err;
      const dryRunResult = parseOptionalBoolean(args, "dryRun");
      if (!dryRunResult.ok) return dryRunResult.err;

      const edits: FileEdit[] = [];
      for (let i = 0; i < editsResult.value.length; i++) {
        const entry = editsResult.value[i];
        if (entry === null || entry === undefined || typeof entry !== "object") {
          return {
            error: `edits[${String(i)}] must be an object, got ${entry === null ? "null" : typeof entry}`,
            code: "VALIDATION",
          };
        }
        const hunk = entry as Record<string, unknown>;
        if (typeof hunk.oldText !== "string") {
          return {
            error: `edits[${String(i)}].oldText must be a string, got ${typeof hunk.oldText}`,
            code: "VALIDATION",
          };
        }
        if (typeof hunk.newText !== "string") {
          return {
            error: `edits[${String(i)}].newText must be a string, got ${typeof hunk.newText}`,
            code: "VALIDATION",
          };
        }
        edits.push({ oldText: hunk.oldText, newText: hunk.newText });
      }

      if (execOptions?.signal?.aborted) {
        return { error: "Operation cancelled", code: "CANCELLED" };
      }

      const options: FileEditOptions = {
        ...(dryRunResult.value !== undefined && { dryRun: dryRunResult.value }),
      };
      const result = await backend.edit(pathResult.value, edits, options);
      if (!result.ok) {
        return { error: result.error.message, code: result.error.code };
      }
      return result.value;
    },
  };
}
