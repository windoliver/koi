import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSource, parseNotebook, serializeNotebook } from "./notebook-parser.js";
import { createNotebookReplaceCellTool } from "./tools/replace-cell.js";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.ipynb");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-roundtrip-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("notebook round-trip via fixture", () => {
  test("reads fixture, parses it, serializes, and re-parses with all cells intact", async () => {
    const text = await Bun.file(FIXTURE_PATH).text();
    const parseResult = parseNotebook(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const nb = parseResult.value;
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[0]?.cell_type).toBe("markdown");
    expect(nb.cells[1]?.cell_type).toBe("code");
    expect(nb.cells[2]?.cell_type).toBe("raw");

    const serialized = serializeNotebook(nb);
    const reParseResult = parseNotebook(serialized);
    expect(reParseResult.ok).toBe(true);
    if (!reParseResult.ok) return;

    const reparsed = reParseResult.value;
    expect(reparsed.nbformat).toBe(nb.nbformat);
    expect(reparsed.cells).toHaveLength(3);

    for (let i = 0; i < nb.cells.length; i++) {
      const orig = nb.cells[i];
      const re = reparsed.cells[i];
      if (!orig || !re) continue;
      expect(re.cell_type).toBe(orig.cell_type);
      expect(re.id).toBe(orig.id);
      expect(normalizeSource(re.source)).toBe(normalizeSource(orig.source));
    }
  });

  test("edits a cell in fixture copy and verifies content preserved after round-trip", async () => {
    const nbPath = join(tmpDir, "sample.ipynb");
    await copyFile(FIXTURE_PATH, nbPath);

    const tool = createNotebookReplaceCellTool({});
    await tool.execute({
      path: nbPath,
      index: 1,
      cell_type: "code",
      source: "y = 99\nprint(y)",
    });

    const text = await Bun.file(nbPath).text();
    const parseResult = parseNotebook(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const nb = parseResult.value;
    expect(nb.cells).toHaveLength(3);

    // Cell 0 and 2 should be unchanged
    expect(nb.cells[0]?.id).toBe("aaa11111");
    expect(nb.cells[2]?.id).toBe("ccc33333");

    // Cell 1 should be replaced
    const replaced = nb.cells[1];
    expect(replaced?.id).toBe("bbb22222");
    expect(replaced?.cell_type).toBe("code");
    expect(normalizeSource(replaced?.source ?? [])).toBe("y = 99\nprint(y)");
    // Outputs should be cleared
    expect(replaced?.outputs).toEqual([]);
    expect(replaced?.execution_count).toBeNull();
  });

  test("fixture has correct structure: markdown, code with output, raw", async () => {
    const text = await Bun.file(FIXTURE_PATH).text();
    const parseResult = parseNotebook(text);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const nb = parseResult.value;

    const markdown = nb.cells[0];
    expect(markdown?.cell_type).toBe("markdown");
    expect(normalizeSource(markdown?.source ?? [])).toContain("Sample Notebook");

    const code = nb.cells[1];
    expect(code?.cell_type).toBe("code");
    expect(code?.outputs).toHaveLength(1);
    expect(code?.execution_count).toBe(1);

    const raw = nb.cells[2];
    expect(raw?.cell_type).toBe("raw");
    expect(normalizeSource(raw?.source ?? [])).toContain("title: Sample");
  });
});
