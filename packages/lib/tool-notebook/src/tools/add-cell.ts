/**
 * Tool factory for notebook_add_cell — inserts a new cell into a .ipynb file.
 */

import type { JsonObject, Tool, ToolExecuteOptions } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createCell, parseNotebook, serializeNotebook } from "../notebook-parser.js";
import { parseCellType, parseOptionalIndex, parsePath, parseSource } from "../parse-args.js";
import type { NotebookToolConfig } from "./read.js";

export function createNotebookAddCellTool(config: NotebookToolConfig): Tool {
  const policy = config.policy ?? DEFAULT_UNSANDBOXED_POLICY;

  return {
    descriptor: {
      name: "notebook_add_cell",
      description:
        "Add a new cell (code, markdown, or raw) to a Jupyter notebook at the given index. " +
        "If index is omitted or out of range, appends to the end.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the .ipynb file",
          },
          cell_type: {
            type: "string",
            enum: ["code", "markdown", "raw"],
            description: "Type of cell to insert",
          },
          source: {
            type: "string",
            description: "Cell source content",
          },
          index: {
            type: "number",
            description: "Insert position (0-based). Clamped to valid range. Default: end.",
          },
        },
        required: ["path", "cell_type", "source"],
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

      const cellTypeResult = parseCellType(args, "cell_type");
      if (!cellTypeResult.ok) return cellTypeResult.err;

      const sourceResult = parseSource(args, "source");
      if (!sourceResult.ok) return sourceResult.err;

      const indexResult = parseOptionalIndex(args, "index");
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
      const newCell = createCell(
        cellTypeResult.value,
        sourceResult.value,
        nb.nbformat,
        nb.nbformat_minor,
      );
      const cellCount = nb.cells.length;

      // Clamp index to [0, cellCount]
      const rawIndex = indexResult.value;
      const insertIndex =
        rawIndex === undefined
          ? cellCount
          : rawIndex < 0
            ? 0
            : rawIndex > cellCount
              ? cellCount
              : rawIndex;

      const newCells = [...nb.cells.slice(0, insertIndex), newCell, ...nb.cells.slice(insertIndex)];

      const updated = { ...nb, cells: newCells };

      try {
        await Bun.write(path, serializeNotebook(updated));
      } catch (e: unknown) {
        return {
          error: `Failed to write file: ${e instanceof Error ? e.message : String(e)}`,
          code: "INTERNAL",
        };
      }

      return {
        path,
        index: insertIndex,
        cell_type: cellTypeResult.value,
        cellCount: newCells.length,
      };
    },
  };
}
