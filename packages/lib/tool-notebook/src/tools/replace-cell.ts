/**
 * Tool factory for notebook_replace_cell — replaces content of an existing cell.
 * Preserves cell id and metadata. Clears outputs/execution_count for code cells.
 */

import type { JsonObject, Tool, ToolExecuteOptions } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { NotebookCell } from "../notebook-parser.js";
import { parseNotebook, serializeNotebook, sourceToArray } from "../notebook-parser.js";
import { parseCellType, parsePath, parseRequiredIndex, parseSource } from "../parse-args.js";
import type { NotebookToolConfig } from "./read.js";

export function createNotebookReplaceCellTool(config: NotebookToolConfig): Tool {
  const policy = config.policy ?? DEFAULT_UNSANDBOXED_POLICY;

  return {
    descriptor: {
      name: "notebook_replace_cell",
      description:
        "Replace the content of an existing cell in a Jupyter notebook. " +
        "Preserves the cell ID and metadata. Returns VALIDATION error if index is out of bounds.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the .ipynb file",
          },
          index: {
            type: "number",
            description: "Zero-based cell index to replace",
          },
          cell_type: {
            type: "string",
            enum: ["code", "markdown", "raw"],
            description: "New cell type",
          },
          source: {
            type: "string",
            description: "New cell source content",
          },
        },
        required: ["path", "index", "cell_type", "source"],
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

      const cellTypeResult = parseCellType(args, "cell_type");
      if (!cellTypeResult.ok) return cellTypeResult.err;

      const sourceResult = parseSource(args, "source");
      if (!sourceResult.ok) return sourceResult.err;

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

      const existing = nb.cells[targetIndex];
      if (existing === undefined) {
        return { error: `Cell at index ${targetIndex} not found`, code: "VALIDATION" };
      }

      const newSource = sourceToArray(sourceResult.value);
      const newCellType = cellTypeResult.value;

      // Preserve existing.id only if present (optional for nbformat < 4.5)
      const idField = existing.id !== undefined ? { id: existing.id } : {};
      let replaced: NotebookCell;
      if (newCellType === "code") {
        replaced = {
          cell_type: newCellType,
          ...idField,
          metadata: existing.metadata,
          source: newSource,
          outputs: [],
          execution_count: null,
        };
      } else {
        replaced = {
          cell_type: newCellType,
          ...idField,
          metadata: existing.metadata,
          source: newSource,
        };
      }

      const newCells = [
        ...nb.cells.slice(0, targetIndex),
        replaced,
        ...nb.cells.slice(targetIndex + 1),
      ];

      const updated = { ...nb, cells: newCells };

      try {
        await Bun.write(path, serializeNotebook(updated));
      } catch (e: unknown) {
        return {
          error: `Failed to write file: ${e instanceof Error ? e.message : String(e)}`,
          code: "INTERNAL",
        };
      }

      return { path, index: targetIndex, cell_type: newCellType };
    },
  };
}
