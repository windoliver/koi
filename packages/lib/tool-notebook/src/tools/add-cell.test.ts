import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSource, parseNotebook } from "../notebook-parser.js";
import { createNotebookAddCellTool } from "./add-cell.js";

const makeNotebook = (cellCount = 2): string =>
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: Array.from({ length: cellCount }, (_, i) => ({
      cell_type: i === 0 ? "markdown" : "code",
      id: `cell${i}`,
      metadata: {},
      source: [`cell ${i} source`],
      ...(i > 0 ? { outputs: [], execution_count: null } : {}),
    })),
  });

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-test-add-cell-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createNotebookAddCellTool", () => {
  test("adds a code cell at the end (default)", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, makeNotebook(2));

    const tool = createNotebookAddCellTool({});
    const result = (await tool.execute({
      path: nbPath,
      cell_type: "code",
      source: "x = 42",
    })) as { index: number; cell_type: string; cellCount: number };

    expect(result.cell_type).toBe("code");
    expect(result.index).toBe(2);
    expect(result.cellCount).toBe(3);

    // Verify written content
    const written = await Bun.file(nbPath).text();
    const parsed = parseNotebook(written);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cells).toHaveLength(3);
    const lastCell = parsed.value.cells[2];
    expect(lastCell?.cell_type).toBe("code");
    expect(normalizeSource(lastCell?.source ?? [])).toBe("x = 42");
  });

  test("adds a markdown cell at index 0 (prepend)", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, makeNotebook(2));

    const tool = createNotebookAddCellTool({});
    const result = (await tool.execute({
      path: nbPath,
      cell_type: "markdown",
      source: "# Prepended",
      index: 0,
    })) as { index: number; cell_type: string; cellCount: number };

    expect(result.index).toBe(0);
    expect(result.cell_type).toBe("markdown");
    expect(result.cellCount).toBe(3);

    const written = await Bun.file(nbPath).text();
    const parsed = parseNotebook(written);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(normalizeSource(parsed.value.cells[0]?.source ?? [])).toBe("# Prepended");
  });

  test("clamps out-of-range negative index to 0", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, makeNotebook(2));

    const tool = createNotebookAddCellTool({});
    const result = (await tool.execute({
      path: nbPath,
      cell_type: "raw",
      source: "raw content",
      index: -5,
    })) as { index: number };

    expect(result.index).toBe(0);
  });

  test("clamps index beyond cellCount to end", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, makeNotebook(2));

    const tool = createNotebookAddCellTool({});
    const result = (await tool.execute({
      path: nbPath,
      cell_type: "code",
      source: "pass",
      index: 999,
    })) as { index: number; cellCount: number };

    expect(result.index).toBe(2);
    expect(result.cellCount).toBe(3);
  });

  test("writes result back to disk and verifies round-trip", async () => {
    const nbPath = join(tmpDir, "roundtrip.ipynb");
    await writeFile(nbPath, makeNotebook(1));

    const tool = createNotebookAddCellTool({});
    await tool.execute({
      path: nbPath,
      cell_type: "code",
      source: "result = 'hello'",
      index: 1,
    });

    const text = await Bun.file(nbPath).text();
    const parsed = parseNotebook(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cells).toHaveLength(2);
    expect(normalizeSource(parsed.value.cells[1]?.source ?? [])).toBe("result = 'hello'");
  });

  test("returns NOT_FOUND for nonexistent file", async () => {
    const tool = createNotebookAddCellTool({});
    const result = (await tool.execute({
      path: join(tmpDir, "missing.ipynb"),
      cell_type: "code",
      source: "pass",
    })) as { code: string };

    expect(result.code).toBe("NOT_FOUND");
  });
});
