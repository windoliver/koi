import { describe, expect, test } from "bun:test";

import type { TrajectoryEntry } from "@koi/ace-types";

import { aggregateTrajectoryStats, curateTrajectorySummary } from "./stats-aggregator.js";

function entry(p: Partial<TrajectoryEntry>): TrajectoryEntry {
  return {
    turnIndex: 0,
    timestamp: 0,
    kind: "tool_call",
    identifier: "fs.read",
    outcome: "success",
    durationMs: 10,
    ...p,
  };
}

describe("aggregateTrajectoryStats", () => {
  test("returns empty map for no entries", () => {
    expect(aggregateTrajectoryStats([]).size).toBe(0);
  });

  test("groups by kind+identifier and counts outcomes", () => {
    const entries: readonly TrajectoryEntry[] = [
      entry({ identifier: "a", outcome: "success", durationMs: 10, timestamp: 1 }),
      entry({ identifier: "a", outcome: "failure", durationMs: 20, timestamp: 5 }),
      entry({ identifier: "a", outcome: "retry", durationMs: 30, timestamp: 3 }),
      entry({ identifier: "b", outcome: "success", durationMs: 40, timestamp: 9 }),
    ];

    const stats = aggregateTrajectoryStats(entries);
    expect(stats.size).toBe(2);

    const a = stats.get("tool_call:a");
    expect(a).toEqual({
      identifier: "a",
      kind: "tool_call",
      successes: 1,
      failures: 1,
      retries: 1,
      totalDurationMs: 60,
      invocations: 3,
      lastSeenMs: 5,
    });
    expect(stats.get("tool_call:b")?.invocations).toBe(1);
  });

  test("keys disambiguate by kind", () => {
    const stats = aggregateTrajectoryStats([
      entry({ kind: "tool_call", identifier: "x" }),
      entry({ kind: "model_call", identifier: "x" }),
    ]);
    expect(stats.size).toBe(2);
    expect(stats.get("tool_call:x")).toBeDefined();
    expect(stats.get("model_call:x")).toBeDefined();
  });
});

describe("curateTrajectorySummary", () => {
  test("filters by minScore and sorts descending", () => {
    const stats = aggregateTrajectoryStats([
      entry({ identifier: "low", outcome: "failure", timestamp: 0 }),
      entry({ identifier: "low", outcome: "failure", timestamp: 0 }),
      entry({ identifier: "high", outcome: "success", timestamp: 0 }),
      entry({ identifier: "high", outcome: "success", timestamp: 0 }),
    ]);

    const candidates = curateTrajectorySummary(stats, 1, {
      minScore: 0.1,
      nowMs: 0,
      lambda: 0,
    });

    expect(candidates.length).toBe(1);
    expect(candidates[0]?.identifier).toBe("high");
    expect(candidates[0]?.score).toBe(1);
  });

  test("scorer override wins", () => {
    const stats = aggregateTrajectoryStats([entry({ identifier: "x" })]);
    const candidates = curateTrajectorySummary(stats, 1, {
      minScore: 0,
      nowMs: 0,
      lambda: 0,
      scorer: () => 0.42,
    });
    expect(candidates[0]?.score).toBe(0.42);
  });
});
