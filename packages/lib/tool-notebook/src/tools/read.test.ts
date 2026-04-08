import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotebookReadTool } from "./read.js";

const VALID_NOTEBOOK = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: "markdown",
      id: "aaa111",
      metadata: {},
      source: ["# Hello\n", "World"],
    },
    {
      cell_type: "code",
      id: "bbb222",
      metadata: {},
      source: ["x = 1\n"],
      outputs: [{ output_type: "stream", text: ["1\n"] }],
      execution_count: 1,
    },
  ],
});

const EMPTY_NOTEBOOK = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [],
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-test-notebook-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createNotebookReadTool", () => {
  test("reads a valid .ipynb file and returns correct cell summary", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, VALID_NOTEBOOK);

    const tool = createNotebookReadTool({});
    const result = await tool.execute({ path: nbPath });

    expect(result).toMatchObject({
      path: nbPath,
      nbformat: 4,
      cellCount: 2,
    });

    const r = result as {
      cells: Array<{
        index: number;
        cell_type: string;
        source: string;
        outputCount: number;
        executionCount: number | null;
      }>;
    };
    expect(r.cells).toHaveLength(2);
    expect(r.cells[0]).toMatchObject({
      index: 0,
      cell_type: "markdown",
      source: "# Hello\nWorld",
      outputCount: 0,
      executionCount: null,
    });
    expect(r.cells[1]).toMatchObject({
      index: 1,
      cell_type: "code",
      outputCount: 1,
      executionCount: 1,
    });
  });

  test("empty notebook returns empty cells array", async () => {
    const nbPath = join(tmpDir, "empty.ipynb");
    await writeFile(nbPath, EMPTY_NOTEBOOK);

    const tool = createNotebookReadTool({});
    const result = (await tool.execute({ path: nbPath })) as {
      cellCount: number;
      cells: unknown[];
    };

    expect(result.cellCount).toBe(0);
    expect(result.cells).toHaveLength(0);
  });

  test("returns NOT_FOUND error for nonexistent file", async () => {
    const tool = createNotebookReadTool({});
    const result = (await tool.execute({ path: join(tmpDir, "nonexistent.ipynb") })) as {
      code: string;
    };

    expect(result.code).toBe("NOT_FOUND");
  });

  test("returns VALIDATION error for invalid JSON file", async () => {
    const nbPath = join(tmpDir, "invalid.ipynb");
    await writeFile(nbPath, "{ not valid json }");

    const tool = createNotebookReadTool({});
    const result = (await tool.execute({ path: nbPath })) as { code: string };

    expect(result.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error when path arg is missing", async () => {
    const tool = createNotebookReadTool({});
    const result = (await tool.execute({})) as { code: string; error: string };

    expect(result.code).toBe("VALIDATION");
  });
});
