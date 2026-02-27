import { describe, expect, test } from "bun:test";
import type { TurnTrace } from "@koi/core";
import { sessionId } from "@koi/core";
import { computeSuggestedName, detectPatterns, filterSubsumed } from "./detect-patterns.js";
import type { CrystallizationCandidate, ToolNgram } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTrace(turnIndex: number, toolIds: readonly string[]): TurnTrace {
  return {
    turnIndex,
    sessionId: sessionId("test-session"),
    agentId: "test-agent",
    events: toolIds.map((toolId, i) => ({
      eventIndex: i,
      turnIndex,
      event: {
        kind: "tool_call" as const,
        toolId,
        callId: `call-${i}` as import("@koi/core").ToolCallId,
        input: {},
        output: {},
        durationMs: 10,
      },
      timestamp: 1000 + i,
    })),
    durationMs: toolIds.length * 10,
  };
}

function createCandidate(
  toolIds: readonly string[],
  occurrences: number,
): CrystallizationCandidate {
  const key = toolIds.join("|");
  return {
    ngram: { steps: toolIds.map((id) => ({ toolId: id })), key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt: 1000,
    suggestedName: toolIds.join("-then-"),
  };
}

// ---------------------------------------------------------------------------
// computeSuggestedName
// ---------------------------------------------------------------------------

describe("computeSuggestedName", () => {
  test("joins tool IDs with -then-", () => {
    const ngram: ToolNgram = {
      steps: [{ toolId: "fetch" }, { toolId: "parse" }],
      key: "fetch|parse",
    };
    expect(computeSuggestedName(ngram)).toBe("fetch-then-parse");
  });

  test("replaces underscores with hyphens", () => {
    const ngram: ToolNgram = {
      steps: [{ toolId: "read_file" }, { toolId: "write_file" }],
      key: "read_file|write_file",
    };
    expect(computeSuggestedName(ngram)).toBe("read-file-then-write-file");
  });

  test("truncates long names at 60 chars", () => {
    const ngram: ToolNgram = {
      steps: [
        { toolId: "very_long_tool_name_one" },
        { toolId: "very_long_tool_name_two" },
        { toolId: "very_long_tool_name_three" },
      ],
      key: "x",
    };
    const name = computeSuggestedName(ngram);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith("...")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterSubsumed
// ---------------------------------------------------------------------------

describe("filterSubsumed", () => {
  test("removes shorter patterns subsumed by longer ones", () => {
    // "a|b" appears 3 times, "a|b|c" also appears 3 times
    // "a|b" is subsumed by "a|b|c" because the longer key contains it
    const short = createCandidate(["a", "b"], 3);
    const long = createCandidate(["a", "b", "c"], 3);

    const result = filterSubsumed([short, long]);
    expect(result).toHaveLength(1);
    expect(result[0]?.ngram.key).toBe("a|b|c");
  });

  test("keeps shorter patterns with higher frequency", () => {
    const short = createCandidate(["a", "b"], 5);
    const long = createCandidate(["a", "b", "c"], 3);

    const result = filterSubsumed([short, long]);
    expect(result).toHaveLength(2);
  });

  test("keeps non-overlapping patterns", () => {
    const first = createCandidate(["a", "b"], 3);
    const second = createCandidate(["c", "d"], 3);

    const result = filterSubsumed([first, second]);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// detectPatterns
// ---------------------------------------------------------------------------

describe("detectPatterns", () => {
  test("detects pattern occurring above threshold", () => {
    const traces = [
      createTrace(0, ["fetch", "parse", "save"]),
      createTrace(1, ["fetch", "parse", "save"]),
      createTrace(2, ["fetch", "parse", "save"]),
    ];
    const result = detectPatterns(traces, { minOccurrences: 3 }, new Set(), () => 2000);
    expect(result.length).toBeGreaterThan(0);
    const keys = result.map((c) => c.ngram.key);
    // Should find "fetch|parse|save" (3-gram) with 3 occurrences
    expect(keys).toContain("fetch|parse|save");
  });

  test("returns empty for patterns below threshold", () => {
    const traces = [createTrace(0, ["fetch", "parse"]), createTrace(1, ["fetch", "parse"])];
    const result = detectPatterns(traces, { minOccurrences: 3 }, new Set(), () => 2000);
    expect(result).toHaveLength(0);
  });

  test("excludes dismissed patterns", () => {
    const traces = [
      createTrace(0, ["fetch", "parse"]),
      createTrace(1, ["fetch", "parse"]),
      createTrace(2, ["fetch", "parse"]),
    ];
    const dismissed = new Set(["fetch|parse"]);
    const result = detectPatterns(traces, { minOccurrences: 3 }, dismissed, () => 2000);
    expect(result).toHaveLength(0);
  });

  test("respects maxCandidates", () => {
    // Create many different repeated patterns
    const traces = [
      createTrace(0, ["a", "b", "c", "d", "e", "f"]),
      createTrace(1, ["a", "b", "c", "d", "e", "f"]),
      createTrace(2, ["a", "b", "c", "d", "e", "f"]),
    ];
    const result = detectPatterns(
      traces,
      { minOccurrences: 3, maxCandidates: 2 },
      new Set(),
      () => 2000,
    );
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test("prefers longer n-grams via subsumption", () => {
    const traces = [
      createTrace(0, ["fetch", "parse", "save"]),
      createTrace(1, ["fetch", "parse", "save"]),
      createTrace(2, ["fetch", "parse", "save"]),
    ];
    const result = detectPatterns(
      traces,
      { minOccurrences: 3, minNgramSize: 2, maxNgramSize: 3 },
      new Set(),
      () => 2000,
    );
    // "fetch|parse|save" (3-gram) should subsume "fetch|parse" and "parse|save" (2-grams)
    const keys = result.map((c) => c.ngram.key);
    expect(keys).toContain("fetch|parse|save");
    expect(keys).not.toContain("fetch|parse");
    expect(keys).not.toContain("parse|save");
  });

  test("returns candidates sorted by occurrences descending", () => {
    const traces = [
      createTrace(0, ["a", "b"]),
      createTrace(1, ["a", "b"]),
      createTrace(2, ["a", "b"]),
      createTrace(3, ["c", "d"]),
      createTrace(4, ["c", "d"]),
      createTrace(5, ["c", "d"]),
      createTrace(6, ["c", "d"]),
    ];
    const result = detectPatterns(traces, { minOccurrences: 3 }, new Set(), () => 2000);
    if (result.length >= 2) {
      const first = result[0];
      const second = result[1];
      if (first !== undefined && second !== undefined) {
        expect(first.occurrences).toBeGreaterThanOrEqual(second.occurrences);
      }
    }
  });
});
