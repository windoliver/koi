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
import type { FsToolOptions } from "./read.js";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + 1;
  }
  return count;
}

export function createFsEditTool(
  backend: FileSystemBackend,
  prefix: string,
  policy: ToolPolicy,
  fsToolOptions?: FsToolOptions,
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

      if (fsToolOptions?.pathGuard !== undefined) {
        const guardResult = fsToolOptions.pathGuard(pathResult.value);
        if (!guardResult.ok) {
          return { error: guardResult.reason, code: "CREDENTIAL_PATH_DENIED" };
        }
      }

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
        if (hunk.oldText.length === 0) {
          return {
            error: `edits[${String(i)}].oldText must not be empty — empty match would replace entire file`,
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

      // Preflight: read file and simulate sequential application to catch
      // interacting hunks (e.g. hunk 1 creates a new match for hunk 2)
      const readResult = await backend.read(pathResult.value);
      if (!readResult.ok) {
        return { error: readResult.error.message, code: readResult.error.code };
      }
      let workingContent = readResult.value.content;
      for (let i = 0; i < edits.length; i++) {
        const hunk = edits[i];
        if (hunk === undefined) continue;
        const occurrences = countOccurrences(workingContent, hunk.oldText);
        if (occurrences === 0) {
          return {
            error: `edits[${String(i)}].oldText not found in file`,
            code: "NOT_FOUND",
          };
        }
        if (occurrences > 1) {
          return {
            error: `edits[${String(i)}].oldText matches ${String(occurrences)} locations — must be unique`,
            code: "AMBIGUOUS",
          };
        }
        // Simulate this replacement so subsequent hunks validate against updated content
        workingContent = workingContent.replace(hunk.oldText, hunk.newText);
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
