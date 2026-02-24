import { describe, expect, test } from "bun:test";
import { curateTrajectorySummary } from "./curator.js";
import type { AggregatedStats } from "./types.js";

function makeStats(overrides?: Partial<AggregatedStats>): AggregatedStats {
  return {
    identifier: "tool-a",
    kind: "tool_call",
    successes: 8,
    failures: 2,
    retries: 0,
    totalDurationMs: 500,
    invocations: 10,
    lastSeenMs: 1000,
    ...overrides,
  };
}

describe("curateTrajectorySummary", () => {
  test("returns empty for empty stats", () => {
    const result = curateTrajectorySummary(new Map(), 5, {
      minScore: 0.1,
      nowMs: 1000,
      lambda: 0.01,
    });
    expect(result).toHaveLength(0);
  });

  test("filters out entries below minScore", () => {
    const stats = new Map([["tool-a", makeStats({ successes: 0, failures: 10, invocations: 10 })]]);
    const result = curateTrajectorySummary(stats, 5, {
      minScore: 0.1,
      nowMs: 1000,
      lambda: 0.01,
    });
    expect(result).toHaveLength(0);
  });

  test("includes entries above minScore", () => {
    const stats = new Map([["tool-a", makeStats({ successes: 8, failures: 2, invocations: 10 })]]);
    const result = curateTrajectorySummary(stats, 5, {
      minScore: 0.1,
      nowMs: 1000,
      lambda: 0.01,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.identifier).toBe("tool-a");
  });

  test("sorts by score descending", () => {
    const stats = new Map([
      [
        "tool-low",
        makeStats({
          identifier: "tool-low",
          successes: 3,
          failures: 7,
          invocations: 10,
        }),
      ],
      [
        "tool-high",
        makeStats({
          identifier: "tool-high",
          successes: 10,
          failures: 0,
          invocations: 10,
        }),
      ],
    ]);
    const result = curateTrajectorySummary(stats, 5, {
      minScore: 0.01,
      nowMs: 1000,
      lambda: 0.01,
    });
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]?.identifier).toBe("tool-high");
  });

  test("includes stats in each candidate", () => {
    const stat = makeStats({ identifier: "tool-a" });
    const stats = new Map([["tool-a", stat]]);
    const result = curateTrajectorySummary(stats, 5, {
      minScore: 0.01,
      nowMs: 1000,
      lambda: 0.01,
    });
    expect(result[0]?.stats).toEqual(stat);
  });

  test("preserves kind from stats", () => {
    const stats = new Map([["model-x", makeStats({ identifier: "model-x", kind: "model_call" })]]);
    const result = curateTrajectorySummary(stats, 5, {
      minScore: 0.01,
      nowMs: 1000,
      lambda: 0.01,
    });
    expect(result[0]?.kind).toBe("model_call");
  });

  test("uses custom scorer when provided", () => {
    const stats = new Map([["tool-a", makeStats()]]);
    const customScorer = (): number => 0.42;
    const result = curateTrajectorySummary(stats, 5, {
      scorer: customScorer,
      minScore: 0.1,
      nowMs: 1000,
      lambda: 0.01,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBeCloseTo(0.42, 5);
  });

  test("fixture: multi-tool session produces expected candidates", () => {
    const stats = new Map([
      [
        "read-file",
        makeStats({
          identifier: "read-file",
          kind: "tool_call",
          successes: 8,
          failures: 2,
          invocations: 10,
          lastSeenMs: 1000,
        }),
      ],
      [
        "write-file",
        makeStats({
          identifier: "write-file",
          kind: "tool_call",
          successes: 5,
          failures: 5,
          invocations: 10,
          lastSeenMs: 1000,
        }),
      ],
      [
        "gpt-4",
        makeStats({
          identifier: "gpt-4",
          kind: "model_call",
          successes: 20,
          failures: 0,
          invocations: 20,
          lastSeenMs: 1000,
        }),
      ],
    ]);

    const result = curateTrajectorySummary(stats, 10, {
      minScore: 0.1,
      nowMs: 1000,
      lambda: 0.01,
    });

    // gpt-4: freq=2, successRate=1.0 → score=1.0 (capped)
    // read-file: freq=1, successRate=0.8 → score=0.8
    // write-file: freq=1, successRate=0.5 → score=0.5
    expect(result[0]?.identifier).toBe("gpt-4");
    // All three should pass min threshold
    expect(result).toHaveLength(3);
  });

  test("zero invocation entries produce score 0", () => {
    const stats = new Map([
      ["empty", makeStats({ identifier: "empty", invocations: 0, successes: 0, failures: 0 })],
    ]);
    const result = curateTrajectorySummary(stats, 5, {
      minScore: 0.1,
      nowMs: 1000,
      lambda: 0.01,
    });
    expect(result).toHaveLength(0);
  });
});
