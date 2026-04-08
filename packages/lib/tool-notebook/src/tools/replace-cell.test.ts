import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSource, parseNotebook } from "../notebook-parser.js";
import { createNotebookReplaceCellTool } from "./replace-cell.js";

const NOTEBOOK_WITH_IDS = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: "markdown",
      id: "preserved-id-001",
      metadata: { custom: "meta" },
      source: ["# Original\n"],
    },
    {
      cell_type: "code",
      id: "preserved-id-002",
      metadata: {},
      source: ["old = True\n"],
      outputs: [{ output_type: "stream", text: ["True\n"] }],
      execution_count: 3,
    },
  ],
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-test-replace-cell-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createNotebookReplaceCellTool", () => {
  test("replaces cell at valid index and preserves id", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, NOTEBOOK_WITH_IDS);

    const tool = createNotebookReplaceCellTool({});
    const result = (await tool.execute({
      path: nbPath,
      index: 0,
      cell_type: "markdown",
      source: "# Replaced heading",
    })) as { index: number; cell_type: string };

    expect(result.index).toBe(0);
    expect(result.cell_type).toBe("markdown");

    const written = await Bun.file(nbPath).text();
    const parsed = parseNotebook(written);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const cell = parsed.value.cells[0];
    expect(cell?.id).toBe("preserved-id-001");
    expect(normalizeSource(cell?.source ?? [])).toBe("# Replaced heading");
  });

  test("clears outputs and execution_count when replacing with code cell", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, NOTEBOOK_WITH_IDS);

    const tool = createNotebookReplaceCellTool({});
    await tool.execute({
      path: nbPath,
      index: 1,
      cell_type: "code",
      source: "new_code = True",
    });

    const written = await Bun.file(nbPath).text();
    const parsed = parseNotebook(written);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const cell = parsed.value.cells[1];
    expect(cell?.id).toBe("preserved-id-002");
    expect(cell?.outputs).toEqual([]);
    expect(cell?.execution_count).toBeNull();
    expect(normalizeSource(cell?.source ?? [])).toBe("new_code = True");
  });

  test("returns VALIDATION error when index is out of bounds (too high)", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, NOTEBOOK_WITH_IDS);

    const tool = createNotebookReplaceCellTool({});
    const result = (await tool.execute({
      path: nbPath,
      index: 5,
      cell_type: "code",
      source: "pass",
    })) as { code: string };

    expect(result.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error when index is negative", async () => {
    const nbPath = join(tmpDir, "test.ipynb");
    await writeFile(nbPath, NOTEBOOK_WITH_IDS);

    const tool = createNotebookReplaceCellTool({});
    const result = (await tool.execute({
      path: nbPath,
      index: -1,
      cell_type: "code",
      source: "pass",
    })) as { code: string };

    expect(result.code).toBe("VALIDATION");
  });

  test("writes and verifies round-trip after replace", async () => {
    const nbPath = join(tmpDir, "roundtrip.ipynb");
    await writeFile(nbPath, NOTEBOOK_WITH_IDS);

    const tool = createNotebookReplaceCellTool({});
    await tool.execute({
      path: nbPath,
      index: 0,
      cell_type: "raw",
      source: "---\ntitle: Changed\n---",
    });

    const text = await Bun.file(nbPath).text();
    const parsed = parseNotebook(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cells).toHaveLength(2);
    expect(parsed.value.cells[0]?.cell_type).toBe("raw");
    expect(normalizeSource(parsed.value.cells[0]?.source ?? [])).toBe("---\ntitle: Changed\n---");
  });

  test("returns NOT_FOUND for nonexistent file", async () => {
    const tool = createNotebookReplaceCellTool({});
    const result = (await tool.execute({
      path: join(tmpDir, "missing.ipynb"),
      index: 0,
      cell_type: "code",
      source: "pass",
    })) as { code: string };

    expect(result.code).toBe("NOT_FOUND");
  });
});
