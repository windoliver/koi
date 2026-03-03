/**
 * Tests for resolution error helpers.
 */

import { describe, expect, test } from "bun:test";
import { findClosestMatch, levenshteinDistance } from "@koi/validation";
import { aggregateErrors, formatResolutionError } from "./errors.js";
import type { ResolutionFailure } from "./types.js";

// ---------------------------------------------------------------------------
// levenshteinDistance
// ---------------------------------------------------------------------------

describe("levenshteinDistance", () => {
  test("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  test("returns length of other string when one is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("xyz", "")).toBe(3);
  });

  test("returns 1 for single character difference", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1);
    expect(levenshteinDistance("cat", "car")).toBe(1);
    expect(levenshteinDistance("cat", "cats")).toBe(1);
  });

  test("handles complex differences", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("anthropic", "anthrpic")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// findClosestMatch (moved from local findClosestName to @koi/validation)
// ---------------------------------------------------------------------------

describe("findClosestMatch", () => {
  test("finds closest match within threshold", () => {
    const candidates = ["anthropic", "openai", "openrouter"];
    expect(findClosestMatch("anthrpic", candidates)).toBe("anthropic"); // distance 1
    expect(findClosestMatch("opanai", candidates)).toBe("openai"); // distance 1
  });

  test("returns undefined when no match within threshold", () => {
    const candidates = ["anthropic", "openai"];
    expect(findClosestMatch("completely-different", candidates)).toBeUndefined();
  });

  test("returns undefined for empty candidates", () => {
    expect(findClosestMatch("anything", [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// aggregateErrors
// ---------------------------------------------------------------------------

describe("aggregateErrors", () => {
  test("aggregates multiple failures into one error", () => {
    const failures: ResolutionFailure[] = [
      {
        section: "middleware",
        index: 0,
        name: "mw-a",
        error: { code: "NOT_FOUND", message: "not found", retryable: false },
      },
      {
        section: "model",
        name: "anthropic:claude",
        error: { code: "INTERNAL", message: "API key missing", retryable: false },
      },
    ];

    const error = aggregateErrors(failures);

    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("2 error(s)");
    expect(error.message).toContain("mw-a");
    expect(error.message).toContain("anthropic:claude");
  });

  test("includes section and index in message", () => {
    const failures: ResolutionFailure[] = [
      {
        section: "middleware",
        index: 2,
        name: "mw-c",
        error: { code: "NOT_FOUND", message: "missing", retryable: false },
      },
    ];

    const error = aggregateErrors(failures);
    expect(error.message).toContain("middleware[2]");
  });
});

// ---------------------------------------------------------------------------
// formatResolutionError
// ---------------------------------------------------------------------------

describe("formatResolutionError", () => {
  test("formats error for CLI output", () => {
    const output = formatResolutionError({
      code: "VALIDATION",
      message: "test error",
      retryable: false,
    });

    expect(output).toContain("Resolution error:");
    expect(output).toContain("test error");
    expect(output).toEndWith("\n");
  });
});
