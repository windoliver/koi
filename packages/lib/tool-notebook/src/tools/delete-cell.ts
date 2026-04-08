/**
 * Tool factory for notebook_delete_cell — removes a cell by index.
 */

import type { JsonObject, Tool, ToolExecuteOptions } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { parseNotebook, serializeNotebook } from "../notebook-parser.js";
import { parsePath, parseRequiredIndex } from "../parse-args.js";
import type { NotebookToolConfig } from "./read.js";

export function createNotebookDeleteCellTool(config: NotebookToolConfig): Tool {
  const policy = config.policy ?? DEFAULT_UNSANDBOXED_POLICY;

  return {
    descriptor: {
      name: "notebook_delete_cell",
      description:
        "Delete a cell from a Jupyter notebook by index. " +
        "Returns VALIDATION error if index is out of bounds.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the .ipynb file",
          },
          index: {
            type: "number",
            description: "Zero-based cell index to delete",
          },
        },
        required: ["path", "index"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
      if (options?.signal?.aborted) {
        return { error: "Operation cancelled", code: "CANCELLED" };
      }

      const pathResult = parsePath(args, "path");
      if (!pathResult.ok) return pathResult.err;

      const indexResult = parseRequiredIndex(args, "index");
      if (!indexResult.ok) return indexResult.err;

      const path = pathResult.value;

      let text: string;
      try {
        const file = Bun.file(path);
        const exists = await file.exists();
        if (!exists) {
          return { error: `File not found: ${path}`, code: "NOT_FOUND" };
        }
        text = await file.text();
      } catch (e: unknown) {
        return {
          error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}`,
          code: "INTERNAL",
        };
      }

      if (options?.signal?.aborted) {
        return { error: "Operation cancelled", code: "CANCELLED" };
      }

      const parseResult = parseNotebook(text);
      if (!parseResult.ok) {
        return { error: parseResult.error.message, code: parseResult.error.code };
      }

      const nb = parseResult.value;
      const targetIndex = indexResult.value;

      if (targetIndex < 0 || targetIndex >= nb.cells.length) {
        return {
          error: `Cell index ${targetIndex} is out of bounds (notebook has ${nb.cells.length} cells)`,
          code: "VALIDATION",
        };
      }

      const newCells = [...nb.cells.slice(0, targetIndex), ...nb.cells.slice(targetIndex + 1)];
      const updated = { ...nb, cells: newCells };

      try {
        await Bun.write(path, serializeNotebook(updated));
      } catch (e: unknown) {
        return {
          error: `Failed to write file: ${e instanceof Error ? e.message : String(e)}`,
          code: "INTERNAL",
        };
      }

      return { path, index: targetIndex, cellCount: newCells.length };
    },
  };
}
