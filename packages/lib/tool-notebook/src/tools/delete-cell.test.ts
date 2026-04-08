import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNotebook } from "../notebook-parser.js";
import { createNotebookDeleteCellTool } from "./delete-cell.js";

const makeNotebook = (cellCount = 3): string =>
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: Array.from({ length: cellCount }, (_, i) => ({
      cell_type: "code",
      id: `cell${i}`,
      metadata: {},
      source: [`# cell ${i}`],
      outputs: [],
      execution_count: null,
    })),
  });

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-test-delete-cell-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createNotebookDeleteCellTool", () => {
  test("deletes a cell and decrements count", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, makeNotebook(3));

    const tool = createNotebookDeleteCellTool({});
    const result = (await tool.execute({ path: nbPath, index: 1 })) as {
      index: number;
      cellCount: number;
    };

    expect(result.index).toBe(1);
    expect(result.cellCount).toBe(2);
  });

  test("writes updated notebook and verifies cells", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, makeNotebook(3));

    const tool = createNotebookDeleteCellTool({});
    await tool.execute({ path: nbPath, index: 0 });

    const text = await Bun.file(nbPath).text();
    const parsed = parseNotebook(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cells).toHaveLength(2);
    // cell0 was deleted, cell1 is now first
    expect(parsed.value.cells[0]?.id).toBe("cell1");
  });

  test("returns VALIDATION error when index is out of bounds (too high)", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, makeNotebook(2));

    const tool = createNotebookDeleteCellTool({});
    const result = (await tool.execute({ path: nbPath, index: 5 })) as { code: string };

    expect(result.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error when index is negative", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, makeNotebook(2));

    const tool = createNotebookDeleteCellTool({});
    const result = (await tool.execute({ path: nbPath, index: -1 })) as { code: string };

    expect(result.code).toBe("VALIDATION");
  });

  test("deletes last cell in single-cell notebook", async () => {
    const nbPath = join(tmpDir, "single.ipynb");
    await writeFile(nbPath, makeNotebook(1));

    const tool = createNotebookDeleteCellTool({});
    const result = (await tool.execute({ path: nbPath, index: 0 })) as { cellCount: number };

    expect(result.cellCount).toBe(0);

    const text = await Bun.file(nbPath).text();
    const parsed = parseNotebook(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cells).toHaveLength(0);
  });

  test("returns NOT_FOUND for nonexistent file", async () => {
    const tool = createNotebookDeleteCellTool({});
    const result = (await tool.execute({
      path: join(tmpDir, "missing.ipynb"),
      index: 0,
    })) as { code: string };

    expect(result.code).toBe("NOT_FOUND");
  });
});
