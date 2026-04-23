import { describe, expect, test } from "bun:test";
import { createDefaultExtractor, mapCategoryToMemoryType } from "./extract-regex.js";

describe("mapCategoryToMemoryType", () => {
  test("maps gotcha to feedback", () => {
    expect(mapCategoryToMemoryType("gotcha")).toBe("feedback");
  });

  test("maps correction to feedback", () => {
    expect(mapCategoryToMemoryType("correction")).toBe("feedback");
  });

  test("maps heuristic to feedback (regression #1964: guidance phrases must not become reference)", () => {
    expect(mapCategoryToMemoryType("heuristic")).toBe("feedback");
  });

  test("maps pattern to feedback (regression #1964: best-practice patterns must not become reference)", () => {
    expect(mapCategoryToMemoryType("pattern")).toBe("feedback");
  });

  test("maps preference to user (not persisted until user-scoped store exists)", () => {
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

    // Regression #1964: behavioral guidance must land as feedback, not reference
    test("pattern and heuristic extractions resolve to feedback memoryType", () => {
      const patternResult = extractor.extract("best practice: always validate input at boundaries");
      expect(patternResult[0]?.memoryType).toBe("feedback");

      const heuristicResult = extractor.extract("rule of thumb: keep functions under 50 lines");
      expect(heuristicResult[0]?.memoryType).toBe("feedback");

      const shouldAlwaysResult = extractor.extract(
        "should always: use explicit return types on exports",
      );
      expect(shouldAlwaysResult[0]?.memoryType).toBe("feedback");
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

  describe("plain-text extraction correctness (issue #1966)", () => {
    // Raw JSON is pre-processed by extractJsonStringContent in the middleware
    // layer before reaching the extractor, so the extractor only sees clean
    // plain-text strings. These tests verify that the extractor handles edge
    // cases in plain-text content correctly.

    test("marker extraction preserves embedded quotes in valid learnings", () => {
      const output = `[LEARNING:pattern] Pass "--force" when replaying`;
      const result = extractor.extract(output);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe(`Pass "--force" when replaying`);
    });

    test("marker extraction preserves learning ending with quoted JSON-like token", () => {
      const result = extractor.extract(`[LEARNING:gotcha] Watch for the closing "}"`);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe(`Watch for the closing "}"`);
    });

    test("marker extraction stops at newline boundary", () => {
      const output = "[LEARNING:gotcha] Check nulls carefully\nsome other line";
      const result = extractor.extract(output);
      const markerResult = result.find((r) => r.confidence === 1.0);
      expect(markerResult?.content).toBe("Check nulls carefully");
    });

    test("heuristic extraction preserves embedded quotes in valid learnings", () => {
      const result = extractor.extract(`learned that "bun test" is the right runner`);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe(`"bun test" is the right runner`);
    });

    test("heuristic extraction preserves learning ending in a quoted token", () => {
      const result = extractor.extract(`learned that the command is "bun test"`);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe(`the command is "bun test"`);
    });

    test('heuristic extraction preserves learning ending with quoted "}"', () => {
      const result = extractor.extract(`learned that the sentinel is "]"`);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe(`the sentinel is "]"`);
    });

    test("heuristic extraction stops at newline boundary", () => {
      const output = "learned that: keep functions small\nmore text here";
      const result = extractor.extract(output);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).not.toContain("more text here");
    });
  });
});
