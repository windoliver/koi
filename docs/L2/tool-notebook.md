# @koi/tool-notebook

Layer 2 package — File-level Jupyter notebook manipulation (read and edit `.ipynb` cells). No kernel execution.

## Purpose

Provides tools to inspect and modify `.ipynb` notebook files at the cell level. The tools operate directly on the JSON file — no kernel, no execution, no runtime state. Intended for agents that need to author, review, or refactor notebooks programmatically.

### Operations

- **notebook_read** — Summarize notebook structure: cell count, types, source snippets, output count, execution count.
- **notebook_add_cell** — Insert a new cell (code, markdown, or raw) at a specified index.
- **notebook_replace_cell** — Replace the content of an existing cell, preserving its ID and metadata.
- **notebook_delete_cell** — Remove a cell by index.

## nbformat 4 Structure

Jupyter notebooks are JSON files conforming to the `nbformat` 4 specification:

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "kernelspec": { "display_name": "Python 3", "language": "python", "name": "python3" },
    "language_info": { "name": "python", "version": "3.11.0" }
  },
  "cells": [
    {
      "cell_type": "markdown",
      "id": "abc123",
      "metadata": {},
      "source": ["# Hello\n", "World"]
    },
    {
      "cell_type": "code",
      "id": "def456",
      "metadata": {},
      "source": ["x = 1\n", "print(x)"],
      "outputs": [{ "output_type": "stream", "text": ["1\n"] }],
      "execution_count": 1
    },
    {
      "cell_type": "raw",
      "id": "ghi789",
      "metadata": {},
      "source": ["---\ntitle: My Notebook\n---"]
    }
  ]
}
```

**Key points:**
- `source` is an array of strings in nbformat 4 (one entry per line, newline-terminated except the last). This package normalizes source to a plain string for the model and converts back to array on write.
- `outputs` and `execution_count` are only present on `code` cells. On write, they are preserved from the original cell.
- `id` is a short UUID-like identifier assigned per cell. The package generates random IDs for new cells and preserves existing IDs on replace.
- `metadata` at the notebook and cell level is preserved as-is during edits.

## Architecture

```
L0  @koi/core          Tool, ToolPolicy, DEFAULT_UNSANDBOXED_POLICY, Result<T, KoiError>, JsonObject
        │
L2  @koi/tool-notebook  ← this package
        │
        ├── notebook-parser.ts     pure .ipynb JSON parse/serialize/cell factory
        ├── parse-args.ts          arg validation helpers for notebook tools
        ├── tools/
        │   ├── read.ts            createNotebookReadTool(config)
        │   ├── add-cell.ts        createNotebookAddCellTool(config)
        │   ├── replace-cell.ts    createNotebookReplaceCellTool(config)
        │   └── delete-cell.ts     createNotebookDeleteCellTool(config)
        └── index.ts               public exports
```

No L1, L0u, or other L2 imports. All I/O is via `Bun.file(path).text()` and `Bun.write(path, content)`.

## API

### `createNotebookReadTool(config: NotebookToolConfig): Tool`

Reads a `.ipynb` file and returns a structured summary.

**Config:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `policy` | `ToolPolicy` | no | Defaults to `DEFAULT_UNSANDBOXED_POLICY` |

**Args:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path to the `.ipynb` file |

**Returns:**
```json
{
  "path": "notebook.ipynb",
  "nbformat": 4,
  "cellCount": 3,
  "cells": [
    { "index": 0, "cell_type": "markdown", "source": "# Hello\nWorld", "outputCount": 0, "executionCount": null },
    { "index": 1, "cell_type": "code", "source": "x = 1\nprint(x)", "outputCount": 1, "executionCount": 1 },
    { "index": 2, "cell_type": "raw", "source": "---", "outputCount": 0, "executionCount": null }
  ]
}
```

### `createNotebookAddCellTool(config: NotebookToolConfig): Tool`

Inserts a new cell at the given index (or the end if omitted / out of range).

**Args:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path to the `.ipynb` file |
| `cell_type` | `"code" \| "markdown" \| "raw"` | yes | Type of cell to insert |
| `source` | `string` | yes | Cell source content |
| `index` | `number` | no | Insert position; clamped to `[0, cellCount]` |

**Returns:**
```json
{ "path": "notebook.ipynb", "index": 2, "cell_type": "code", "cellCount": 4 }
```

### `createNotebookReplaceCellTool(config: NotebookToolConfig): Tool`

Replaces the content of an existing cell. Preserves original cell `id` and `metadata`. Replaces `cell_type` and `source`. For code cells, clears `outputs` and `execution_count` to null (since content changed).

**Args:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path to the `.ipynb` file |
| `index` | `number` | yes | Zero-based cell index |
| `cell_type` | `"code" \| "markdown" \| "raw"` | yes | New cell type |
| `source` | `string` | yes | New cell source content |

**Returns:**
```json
{ "path": "notebook.ipynb", "index": 1, "cell_type": "code" }
```

**Error:** `VALIDATION` if `index` is out of bounds.

### `createNotebookDeleteCellTool(config: NotebookToolConfig): Tool`

Removes a cell at the given index.

**Args:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | Path to the `.ipynb` file |
| `index` | `number` | yes | Zero-based cell index |

**Returns:**
```json
{ "path": "notebook.ipynb", "index": 1, "cellCount": 2 }
```

**Error:** `VALIDATION` if `index` is out of bounds.

## Layer Compliance

- **L2 package** — imports from `@koi/core` only.
- No L1 (`@koi/engine`) imports.
- No L0u imports (parsers are self-contained; no dependency on `@koi/errors`, `@koi/validation`, etc.).
- No peer L2 imports.
- All tool instances set `origin: "primordial"`.
- All tool instances default to `DEFAULT_UNSANDBOXED_POLICY`.

## Error Handling

| Situation | Response |
|-----------|----------|
| File not found | `{ error: "...", code: "NOT_FOUND" }` |
| Invalid JSON or not nbformat 4 | `{ error: "...", code: "VALIDATION" }` |
| Arg validation failure | `{ error: "...", code: "VALIDATION" }` |
| Cell index out of bounds | `{ error: "...", code: "VALIDATION" }` |
| Unexpected I/O error | `{ error: "...", code: "INTERNAL" }` |

## Testing

Tests live alongside source (`src/*.test.ts`, `src/tools/*.test.ts`). All tests use `bun:test`.

Fixture: `src/fixtures/sample.ipynb` — minimal 3-cell notebook (markdown, code with output, raw) used for round-trip and integration tests.
