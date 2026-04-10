import { describe, expect, test } from "bun:test";
import {
  createCell,
  normalizeSource,
  parseNotebook,
  serializeNotebook,
  sourceToArray,
} from "./notebook-parser.js";

const VALID_NOTEBOOK = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3" } },
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
      source: ["x = 1\n", "print(x)"],
      outputs: [{ output_type: "stream", text: ["1\n"] }],
      execution_count: 1,
    },
    {
      cell_type: "raw",
      id: "ccc333",
      metadata: {},
      source: ["---\ntitle: Test\n---"],
    },
  ],
});

describe("parseNotebook", () => {
  test("parses a valid nbformat 4 notebook", () => {
    const result = parseNotebook(VALID_NOTEBOOK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.nbformat).toBe(4);
    expect(result.value.cells).toHaveLength(3);
    expect(result.value.cells[0]?.cell_type).toBe("markdown");
    expect(result.value.cells[1]?.cell_type).toBe("code");
    expect(result.value.cells[2]?.cell_type).toBe("raw");
  });

  test("returns VALIDATION error for invalid JSON", () => {
    const result = parseNotebook("{ not valid json }");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Invalid JSON");
  });

  test("returns VALIDATION error when root is not an object", () => {
    const result = parseNotebook('"just a string"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error when nbformat < 4", () => {
    const notebook = JSON.stringify({ nbformat: 3, cells: [] });
    const result = parseNotebook(notebook);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("nbformat");
  });

  test("returns VALIDATION error when nbformat is missing", () => {
    const notebook = JSON.stringify({ cells: [] });
    const result = parseNotebook(notebook);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error when cells field is missing", () => {
    const notebook = JSON.stringify({ nbformat: 4 });
    const result = parseNotebook(notebook);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("cells");
  });

  test("returns VALIDATION error when cells field is not an array", () => {
    const notebook = JSON.stringify({ nbformat: 4, cells: "not an array" });
    const result = parseNotebook(notebook);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION error for cell with invalid cell_type", () => {
    const notebook = JSON.stringify({
      nbformat: 4,
      cells: [{ cell_type: "invalid", id: "abc", metadata: {}, source: [] }],
    });
    const result = parseNotebook(notebook);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("accepts cell without id field (nbformat < 4.5 notebooks)", () => {
    // nbformat 4.4 and earlier did not include cell IDs — parsing must succeed
    const notebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 4,
      cells: [{ cell_type: "code", metadata: {}, source: [] }],
    });
    const result = parseNotebook(notebook);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cells[0]?.id).toBeUndefined();
  });

  test("parses empty cells array", () => {
    const notebook = JSON.stringify({ nbformat: 4, cells: [] });
    const result = parseNotebook(notebook);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cells).toHaveLength(0);
  });
});

describe("normalizeSource", () => {
  test("joins array of strings to a single string", () => {
    const result = normalizeSource(["# Hello\n", "World"]);
    expect(result).toBe("# Hello\nWorld");
  });

  test("passes through a plain string unchanged", () => {
    const result = normalizeSource("already a string");
    expect(result).toBe("already a string");
  });

  test("handles empty array", () => {
    const result = normalizeSource([]);
    expect(result).toBe("");
  });
});

describe("sourceToArray", () => {
  test("splits multiline string into line array with trailing newlines", () => {
    const result = sourceToArray("line one\nline two\nline three");
    expect(result).toEqual(["line one\n", "line two\n", "line three"]);
  });

  test("single line without newline stays as single-element array", () => {
    const result = sourceToArray("single line");
    expect(result).toEqual(["single line"]);
  });

  test("empty string returns empty array", () => {
    const result = sourceToArray("");
    expect(result).toEqual([]);
  });

  test("string ending with newline has no trailing empty entry", () => {
    const result = sourceToArray("line one\n");
    expect(result).toEqual(["line one\n"]);
  });
});

describe("createCell", () => {
  test("assigns id for nbformat 4.5+", () => {
    const cell = createCell("code", "x = 1\nprint(x)", 4, 5);
    expect(cell.cell_type).toBe("code");
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBeNull();
    expect(typeof cell.id).toBe("string");
    expect((cell.id as string).length).toBeGreaterThan(0);
  });

  test("omits id for nbformat 4.4 (pre-id era)", () => {
    const cell = createCell("code", "x = 1", 4, 4);
    expect(cell.id).toBeUndefined();
  });

  test("omits id for nbformat 4.0", () => {
    const cell = createCell("markdown", "# Hello", 4, 0);
    expect(cell.id).toBeUndefined();
  });

  test("creates a markdown cell without outputs field", () => {
    const cell = createCell("markdown", "# Hello", 4, 5);
    expect(cell.cell_type).toBe("markdown");
    expect(cell.outputs).toBeUndefined();
    expect(cell.execution_count).toBeUndefined();
  });

  test("creates a raw cell without outputs field", () => {
    const cell = createCell("raw", "---\ntitle: Test\n---", 4, 5);
    expect(cell.cell_type).toBe("raw");
    expect(cell.outputs).toBeUndefined();
  });

  test("source is stored as line array", () => {
    const cell = createCell("code", "a = 1\nb = 2", 4, 5);
    expect(Array.isArray(cell.source)).toBe(true);
    expect(cell.source).toEqual(["a = 1\n", "b = 2"]);
  });

  test("generates unique ids for different cells (nbformat 4.5)", () => {
    const cell1 = createCell("code", "x = 1", 4, 5);
    const cell2 = createCell("code", "y = 2", 4, 5);
    expect(cell1.id).not.toBe(cell2.id);
  });
});

describe("serializeNotebook round-trip", () => {
  test("serialize then re-parse preserves structure", () => {
    const parseResult = parseNotebook(VALID_NOTEBOOK);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const serialized = serializeNotebook(parseResult.value);
    const reParseResult = parseNotebook(serialized);
    expect(reParseResult.ok).toBe(true);
    if (!reParseResult.ok) return;

    const original = parseResult.value;
    const reparsed = reParseResult.value;

    expect(reparsed.nbformat).toBe(original.nbformat);
    expect(reparsed.cells).toHaveLength(original.cells.length);

    for (let i = 0; i < original.cells.length; i++) {
      const origCell = original.cells[i];
      const reparsedCell = reparsed.cells[i];
      if (!origCell || !reparsedCell) continue;
      expect(reparsedCell.cell_type).toBe(origCell.cell_type);
      expect(reparsedCell.id).toBe(origCell.id);
    }
  });
});
