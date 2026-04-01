import { describe, expect, test } from "bun:test";
import { createDefaultExtractor } from "./extract-learnings.js";

const extractor = createDefaultExtractor();

describe("createDefaultExtractor", () => {
  // ---------------------------------------------------------------------------
  // Marker-based extraction
  // ---------------------------------------------------------------------------

  describe("marker-based extraction", () => {
    test("extracts single marker with valid category", () => {
      const output = "[LEARNING:gotcha] Always use --frozen-lockfile in CI";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("Always use --frozen-lockfile in CI");
      expect(results[0]?.category).toBe("gotcha");
      expect(results[0]?.confidence).toBe(1.0);
    });

    test("extracts multiple markers", () => {
      const output = [
        "[LEARNING:gotcha] API returns 429 after 100 req/min",
        "some other text",
        "[LEARNING:pattern] Exponential backoff with jitter works best",
      ].join("\n");
      const results = extractor.extract(output);
      expect(results).toHaveLength(2);
      expect(results[0]?.category).toBe("gotcha");
      expect(results[1]?.category).toBe("pattern");
    });

    test("maps unknown category to context", () => {
      const output = "[LEARNING:unknown_cat] Some learning";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("context");
    });

    test("handles case-insensitive category matching", () => {
      const output = "[LEARNING:HEURISTIC] Start simple";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("heuristic");
    });

    test("skips malformed markers (no content)", () => {
      const output = "[LEARNING:gotcha] ";
      const results = extractor.extract(output);
      expect(results).toHaveLength(0);
    });

    test("truncates extremely long entries", () => {
      const longContent = "a".repeat(600);
      const output = `[LEARNING:pattern] ${longContent}`;
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.content.length).toBeLessThanOrEqual(500);
    });

    test("preserves unicode content", () => {
      const output = "[LEARNING:context] 日本語のテスト — unicode works fine 🎉";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("日本語のテスト — unicode works fine 🎉");
    });
  });

  // ---------------------------------------------------------------------------
  // Heuristic-based extraction
  // ---------------------------------------------------------------------------

  describe("heuristic-based extraction", () => {
    test("extracts 'learned that' as heuristic", () => {
      const output = "I learned that the API requires OAuth2 tokens.";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("heuristic");
      expect(results[0]?.confidence).toBe(0.7);
    });

    test("extracts 'mistake was' as gotcha", () => {
      const output = "The mistake was using synchronous I/O in the hot path.";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("gotcha");
    });

    test("extracts 'actually' as correction", () => {
      const output = "Actually: the endpoint accepts JSON, not form-encoded data.";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("correction");
    });

    test("extracts 'next time' as pattern", () => {
      const output = "Next time: validate inputs before making the API call.";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("pattern");
    });

    test("extracts 'should always' as pattern", () => {
      const output = "Should always: check the return code before proceeding.";
      const results = extractor.extract(output);
      expect(results).toHaveLength(1);
      expect(results[0]?.category).toBe("pattern");
    });
  });

  // ---------------------------------------------------------------------------
  // Combined behavior
  // ---------------------------------------------------------------------------

  describe("combined extraction", () => {
    test("returns empty array for empty output", () => {
      expect(extractor.extract("")).toEqual([]);
    });

    test("returns empty array for output with no learnings", () => {
      const output = "Completed the task successfully. All tests pass.";
      expect(extractor.extract(output)).toEqual([]);
    });

    test("markers are prioritized over heuristics (sorted by confidence)", () => {
      const output = [
        "I learned that rate limits apply per-API-key.",
        "[LEARNING:gotcha] Rate limit is 100 req/min per key",
      ].join("\n");
      const results = extractor.extract(output);
      expect(results.length).toBeGreaterThanOrEqual(1);
      // First result should be highest confidence (marker = 1.0)
      expect(results[0]?.confidence).toBe(1.0);
    });

    test("deduplicates identical content from markers and heuristics", () => {
      const output = [
        "[LEARNING:gotcha] always validate inputs",
        "I learned that always validate inputs",
      ].join("\n");
      const results = extractor.extract(output);
      // Should deduplicate (case-insensitive)
      const uniqueContents = new Set(results.map((r) => r.content.toLowerCase()));
      expect(uniqueContents.size).toBe(results.length);
    });

    test("handles mixed markers and heuristic patterns", () => {
      const output = [
        "[LEARNING:pattern] Use retry with exponential backoff",
        "Some regular output text",
        "I learned that the service has a 30s timeout",
        "[LEARNING:gotcha] Don't forget to set Content-Type header",
      ].join("\n");
      const results = extractor.extract(output);
      expect(results.length).toBeGreaterThanOrEqual(3);
    });
  });
});
