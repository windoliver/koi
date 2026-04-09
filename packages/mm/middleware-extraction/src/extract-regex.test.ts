import { describe, expect, test } from "bun:test";
import { createDefaultExtractor, mapCategoryToMemoryType } from "./extract-regex.js";

describe("mapCategoryToMemoryType", () => {
  test("maps gotcha to feedback", () => {
    expect(mapCategoryToMemoryType("gotcha")).toBe("feedback");
  });

  test("maps correction to feedback", () => {
    expect(mapCategoryToMemoryType("correction")).toBe("feedback");
  });

  test("maps heuristic to reference", () => {
    expect(mapCategoryToMemoryType("heuristic")).toBe("reference");
  });

  test("maps pattern to reference", () => {
    expect(mapCategoryToMemoryType("pattern")).toBe("reference");
  });

  test("maps preference to user", () => {
    expect(mapCategoryToMemoryType("preference")).toBe("user");
  });

  test("maps context to project", () => {
    expect(mapCategoryToMemoryType("context")).toBe("project");
  });
});

describe("createDefaultExtractor", () => {
  const extractor = createDefaultExtractor();

  describe("marker-based extraction", () => {
    test("extracts single marker", () => {
      const result = extractor.extract("[LEARNING:gotcha] Always check null before access");
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe("Always check null before access");
      expect(result[0]?.category).toBe("gotcha");
      expect(result[0]?.memoryType).toBe("feedback");
      expect(result[0]?.confidence).toBe(1.0);
    });

    test("extracts multiple markers", () => {
      const output = [
        "[LEARNING:gotcha] Check for null",
        "some other text",
        "[LEARNING:pattern] Builder configs are useful",
      ].join("\n");
      const result = extractor.extract(output);
      expect(result).toHaveLength(2);
      expect(result[0]?.category).toBe("gotcha");
      expect(result[1]?.category).toBe("pattern");
    });

    test("defaults unknown category to context", () => {
      const result = extractor.extract("[LEARNING:unknown] Some fact");
      expect(result).toHaveLength(1);
      expect(result[0]?.category).toBe("context");
      expect(result[0]?.memoryType).toBe("project");
    });

    test("skips empty content after marker", () => {
      const result = extractor.extract("[LEARNING:gotcha]   ");
      expect(result).toHaveLength(0);
    });

    test("truncates content exceeding 500 characters", () => {
      const longContent = "x".repeat(600);
      const result = extractor.extract(`[LEARNING:gotcha] ${longContent}`);
      expect(result).toHaveLength(1);
      expect(result[0]?.content.length).toBe(500);
    });
  });

  describe("heuristic extraction", () => {
    test("extracts gotcha from avoid keyword", () => {
      const result = extractor.extract("avoid: using var in strict mode");
      expect(result).toHaveLength(1);
      expect(result[0]?.category).toBe("gotcha");
      expect(result[0]?.confidence).toBe(0.7);
    });

    test("extracts correction from actually keyword", () => {
      const result = extractor.extract("actually: the API returns 204 not 200");
      expect(result).toHaveLength(1);
      expect(result[0]?.category).toBe("correction");
    });

    test("extracts pattern from best practice keyword", () => {
      const result = extractor.extract("best practice: always validate input at boundaries");
      expect(result).toHaveLength(1);
      expect(result[0]?.category).toBe("pattern");
    });

    test("extracts heuristic from rule of thumb keyword", () => {
      const result = extractor.extract("rule of thumb: keep functions under 50 lines");
      expect(result).toHaveLength(1);
      expect(result[0]?.category).toBe("heuristic");
    });

    test("first pattern wins per line", () => {
      // "avoid" matches gotcha, "best practice" would match pattern — gotcha wins
      const result = extractor.extract("avoid: this is also a best practice thing");
      expect(result).toHaveLength(1);
      expect(result[0]?.category).toBe("gotcha");
    });

    test("skips empty lines", () => {
      const result = extractor.extract("\n\n\n");
      expect(result).toHaveLength(0);
    });
  });

  describe("deduplication", () => {
    test("deduplicates same content case-insensitively", () => {
      const output = ["[LEARNING:gotcha] Check for null", "avoid: check for null"].join("\n");
      const result = extractor.extract(output);
      expect(result).toHaveLength(1);
      // Marker (confidence 1.0) wins over heuristic (0.7)
      expect(result[0]?.confidence).toBe(1.0);
    });
  });

  describe("sorting", () => {
    test("sorts by confidence descending", () => {
      const output = ["avoid: something heuristic", "[LEARNING:pattern] something explicit"].join(
        "\n",
      );
      const result = extractor.extract(output);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0]?.confidence).toBeGreaterThanOrEqual(result[1]?.confidence ?? 0);
    });
  });

  test("returns empty for output with no learnings", () => {
    const result = extractor.extract("The function returned 42. Build succeeded.");
    expect(result).toHaveLength(0);
  });
});
