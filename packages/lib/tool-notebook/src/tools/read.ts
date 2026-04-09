/**
 * Tool factory for notebook_read — reads a .ipynb file and returns a cell summary.
 */

import type { JsonObject, Tool, ToolExecuteOptions, ToolPolicy } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { normalizeSource, parseNotebook } from "../notebook-parser.js";
import { parsePath } from "../parse-args.js";

export interface NotebookToolConfig {
  readonly policy?: ToolPolicy | undefined;
  /** Workspace root for path containment. When set, paths are resolved relative to cwd and must stay within it. */
  readonly cwd?: string | undefined;
}

export function createNotebookReadTool(config: NotebookToolConfig): Tool {
  const policy = config.policy ?? DEFAULT_UNSANDBOXED_POLICY;
  const { cwd } = config;

  return {
    descriptor: {
      name: "notebook_read",
      description:
        "Read a Jupyter notebook (.ipynb) and return a summary of its cells: " +
        "type, source, output count, and execution count.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the .ipynb file",
          },
        },
        required: ["path"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
      if (options?.signal?.aborted) {
        return { error: "Operation cancelled", code: "CANCELLED" };
      }

      const pathResult = parsePath(args, "path", cwd);
      if (!pathResult.ok) return pathResult.err;

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
      const cells = nb.cells.map((cell, index) => ({
        index,
        cell_type: cell.cell_type,
        source: normalizeSource(cell.source),
        outputCount: cell.outputs?.length ?? 0,
        executionCount: cell.execution_count ?? null,
      }));

      return {
        path,
        nbformat: nb.nbformat,
        cellCount: nb.cells.length,
        cells,
      };
    },
  };
}
