/**
 * Notebook preset stack — .ipynb read/add/replace/delete tools.
 *
 * Contributes 4 providers (notebook_read, notebook_add_cell,
 * notebook_replace_cell, notebook_delete_cell) from @koi/tool-notebook.
 * No shared state, no cross-stack dependencies — the simplest kind
 * of preset: a pure bundle of provider-scoped tools keyed off `cwd`.
 */

import { createSingleToolProvider } from "@koi/core";
import {
  createNotebookAddCellTool,
  createNotebookDeleteCellTool,
  createNotebookReadTool,
  createNotebookReplaceCellTool,
} from "@koi/tool-notebook";
import type { PresetStack, StackContribution } from "../preset-stacks.js";

export const notebookStack: PresetStack = {
  id: "notebook",
  description:
    "Jupyter notebook tools: notebook_read, notebook_add_cell, notebook_replace_cell, notebook_delete_cell",
  activate: (ctx): StackContribution => {
    const notebookConfig = { cwd: ctx.cwd };
    return {
      middleware: [],
      providers: [
        createSingleToolProvider({
          name: "notebook-read",
          toolName: "notebook_read",
          createTool: () => createNotebookReadTool(notebookConfig),
        }),
        createSingleToolProvider({
          name: "notebook-add-cell",
          toolName: "notebook_add_cell",
          createTool: () => createNotebookAddCellTool(notebookConfig),
        }),
        createSingleToolProvider({
          name: "notebook-replace-cell",
          toolName: "notebook_replace_cell",
          createTool: () => createNotebookReplaceCellTool(notebookConfig),
        }),
        createSingleToolProvider({
          name: "notebook-delete-cell",
          toolName: "notebook_delete_cell",
          createTool: () => createNotebookDeleteCellTool(notebookConfig),
        }),
      ],
    };
  },
};
