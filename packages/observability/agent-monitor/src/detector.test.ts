/**
 * BVA (Boundary Value Analysis) tests for the 5 detection functions.
 *
 * Each signal: N-1 (no fire), N (no fire), N+1 (fire).
 * That gives 15 boundary tests across 5 signals.
 */

import { describe, expect, test } from "bun:test";
import {
  buildKeywordPatterns,
  checkDelegationDepth,
  checkDeniedCalls,
  checkDestructiveRate,
  checkErrorSpike,
  checkGoalDrift,
  checkLatencyAnomaly,
  checkSessionDuration,
  checkTokenSpike,
  checkToolDiversity,
  checkToolPingPong,
  checkToolRate,
  checkToolRepeat,
  matchesAnyObjective,
} from "./detector.js";
import type { LatencyStats } from "./types.js";

// ---------------------------------------------------------------------------
// Signal 1: tool_rate_exceeded
// ---------------------------------------------------------------------------

describe("checkToolRate", () => {
  const threshold = 20;

  test("N-1: does not fire when calls < threshold", () => {
    expect(checkToolRate(threshold - 1, threshold)).toBeNull();
  });

  test("N: does not fire when calls === threshold", () => {
    expect(checkToolRate(threshold, threshold)).toBeNull();
  });

  test("N+1: fires when calls > threshold", () => {
    const result = checkToolRate(threshold + 1, threshold);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "tool_rate_exceeded",
      callsPerTurn: threshold + 1,
      threshold,
    });
  });
});

// ---------------------------------------------------------------------------
// Signal 2: error_spike
// ---------------------------------------------------------------------------

describe("checkErrorSpike", () => {
  const threshold = 10;

  test("N-1: does not fire when errors < threshold", () => {
    expect(checkErrorSpike(threshold - 1, threshold)).toBeNull();
  });

  test("N: does not fire when errors === threshold", () => {
    expect(checkErrorSpike(threshold, threshold)).toBeNull();
  });

  test("N+1: fires when errors > threshold", () => {
    const result = checkErrorSpike(threshold + 1, threshold);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "error_spike",
      errorCount: threshold + 1,
      threshold,
    });
  });
});

// ---------------------------------------------------------------------------
// Signal 3: tool_repeated
// ---------------------------------------------------------------------------

describe("checkToolRepeat", () => {
  const threshold = 5;
  const toolId = "my-tool";

  test("N-1: does not fire when consecutive count < threshold", () => {
    expect(checkToolRepeat(toolId, threshold - 1, threshold)).toBeNull();
  });

  test("N: does not fire when consecutive count === threshold", () => {
    expect(checkToolRepeat(toolId, threshold, threshold)).toBeNull();
  });

  test("N+1: fires when consecutive count > threshold", () => {
    const result = checkToolRepeat(toolId, threshold + 1, threshold);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "tool_repeated",
      toolId,
      repeatCount: threshold + 1,
      threshold,
    });
  });
});

// ---------------------------------------------------------------------------
// Signal 4: model_latency_anomaly
// ---------------------------------------------------------------------------

describe("checkLatencyAnomaly", () => {
  const factor = 3;
  const minSamples = 5;

  // Stats with mean=100, stddev=10 → upper bound = 100 + 3*10 = 130
  const stats: LatencyStats = { count: 10, mean: 100, stddev: 10 };

  test("returns null when count < minSamples (warmup)", () => {
    const warmupStats: LatencyStats = { count: 4, mean: 100, stddev: 10 };
    expect(checkLatencyAnomaly(200, warmupStats, factor, minSamples)).toBeNull();
  });

  test("returns null when stddev === 0 (no variance yet)", () => {
    const noVarianceStats: LatencyStats = { count: 10, mean: 100, stddev: 0 };
    expect(checkLatencyAnomaly(200, noVarianceStats, factor, minSamples)).toBeNull();
  });

  test("N-1: does not fire when latency < upper bound", () => {
    // upper bound = 130, N-1 = 129
    expect(checkLatencyAnomaly(129, stats, factor, minSamples)).toBeNull();
  });

  test("N: does not fire when latency === upper bound", () => {
    // upper bound = 130
    expect(checkLatencyAnomaly(130, stats, factor, minSamples)).toBeNull();
  });

  test("N+1: fires when latency > upper bound", () => {
    // upper bound = 130, N+1 = 131
    const result = checkLatencyAnomaly(131, stats, factor, minSamples);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "model_latency_anomaly",
      latencyMs: 131,
      mean: 100,
      stddev: 10,
      factor,
    });
  });
});

// ---------------------------------------------------------------------------
// Signal 5: denied_tool_calls
// ---------------------------------------------------------------------------

describe("checkDeniedCalls", () => {
  const threshold = 3;

  test("N-1: does not fire when denied count < threshold", () => {
    expect(checkDeniedCalls(threshold - 1, threshold)).toBeNull();
  });

  test("N: does not fire when denied count === threshold", () => {
    expect(checkDeniedCalls(threshold, threshold)).toBeNull();
  });

  test("N+1: fires when denied count > threshold", () => {
    const result = checkDeniedCalls(threshold + 1, threshold);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "denied_tool_calls",
      deniedCount: threshold + 1,
      threshold,
    });
  });
});

// ---------------------------------------------------------------------------
// Gap 1: irreversible_action_rate
// ---------------------------------------------------------------------------

describe("checkDestructiveRate", () => {
  const threshold = 3;
  const toolId = "email-delete";

  test("N-1: does not fire when destructive calls < threshold", () => {
    expect(checkDestructiveRate(toolId, threshold - 1, threshold)).toBeNull();
  });

  test("N: does not fire when destructive calls === threshold", () => {
    expect(checkDestructiveRate(toolId, threshold, threshold)).toBeNull();
  });

  test("N+1: fires when destructive calls > threshold", () => {
    const result = checkDestructiveRate(toolId, threshold + 1, threshold);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "irreversible_action_rate",
      toolId,
      callsThisTurn: threshold + 1,
      threshold,
    });
  });
});

// ---------------------------------------------------------------------------
// Gap 2: token_spike
// ---------------------------------------------------------------------------

describe("checkTokenSpike", () => {
  const factor = 3;
  const minSamples = 5;

  // mean=200, stddev=20 → upper bound = 200 + 3*20 = 260
  const stats: LatencyStats = { count: 10, mean: 200, stddev: 20 };

  test("returns null when count < minSamples (warmup)", () => {
    const warmup: LatencyStats = { count: 4, mean: 200, stddev: 20 };
    expect(checkTokenSpike(500, warmup, factor, minSamples)).toBeNull();
  });

  test("returns null when stddev === 0", () => {
    const noVar: LatencyStats = { count: 10, mean: 200, stddev: 0 };
    expect(checkTokenSpike(500, noVar, factor, minSamples)).toBeNull();
  });

  test("N-1: does not fire when tokens < upper bound", () => {
    // upper bound = 260, N-1 = 259
    expect(checkTokenSpike(259, stats, factor, minSamples)).toBeNull();
  });

  test("N: does not fire when tokens === upper bound", () => {
    expect(checkTokenSpike(260, stats, factor, minSamples)).toBeNull();
  });

  test("N+1: fires when tokens > upper bound", () => {
    const result = checkTokenSpike(261, stats, factor, minSamples);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "token_spike",
      outputTokens: 261,
      mean: 200,
      stddev: 20,
      factor,
    });
  });
});

// ---------------------------------------------------------------------------
// Gap 3: tool_diversity_spike
// ---------------------------------------------------------------------------

describe("checkToolDiversity", () => {
  const threshold = 15;

  test("N-1: does not fire when distinct count < threshold", () => {
    expect(checkToolDiversity(threshold - 1, threshold)).toBeNull();
  });

  test("N: does not fire when distinct count === threshold", () => {
    expect(checkToolDiversity(threshold, threshold)).toBeNull();
  });

  test("N+1: fires when distinct count > threshold", () => {
    const result = checkToolDiversity(threshold + 1, threshold);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "tool_diversity_spike",
      distinctToolCount: threshold + 1,
      threshold,
    });
  });
});

// ---------------------------------------------------------------------------
// Gap A: tool_ping_pong
// ---------------------------------------------------------------------------

describe("checkToolPingPong", () => {
  const threshold = 4;
  const toolIdA = "search";
  const toolIdB = "read";

  test("N-1: does not fire when altCount < threshold", () => {
    expect(checkToolPingPong(toolIdA, toolIdB, threshold - 1, threshold)).toBeNull();
  });

  test("N: does not fire when altCount === threshold", () => {
    expect(checkToolPingPong(toolIdA, toolIdB, threshold, threshold)).toBeNull();
  });

  test("N+1: fires when altCount > threshold", () => {
    const result = checkToolPingPong(toolIdA, toolIdB, threshold + 1, threshold);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "tool_ping_pong",
      toolIdA,
      toolIdB,
      altCount: threshold + 1,
      threshold,
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 2: delegation_depth_exceeded
// ---------------------------------------------------------------------------

describe("checkDelegationDepth", () => {
  const maxDepth = 3;
  const spawnToolId = "forge_agent";

  test("N-1: does not fire when currentDepth < maxDepth", () => {
    expect(checkDelegationDepth(maxDepth - 1, spawnToolId, maxDepth)).toBeNull();
  });

  test("N: fires when currentDepth === maxDepth (child would exceed limit)", () => {
    // Fire condition: currentDepth >= maxDepth
    const result = checkDelegationDepth(maxDepth, spawnToolId, maxDepth);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "delegation_depth_exceeded",
      currentDepth: maxDepth,
      maxDepth,
      spawnToolId,
    });
  });

  test("N+1: fires when currentDepth > maxDepth", () => {
    const result = checkDelegationDepth(maxDepth + 1, spawnToolId, maxDepth);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "delegation_depth_exceeded",
      currentDepth: maxDepth + 1,
      maxDepth,
      spawnToolId,
    });
  });

  test("includes spawnToolId in the signal", () => {
    const result = checkDelegationDepth(maxDepth, "custom_spawn", maxDepth);
    expect(result?.spawnToolId).toBe("custom_spawn");
  });
});

// ---------------------------------------------------------------------------
// Gap B: session_duration_exceeded
// ---------------------------------------------------------------------------

describe("checkSessionDuration", () => {
  const threshold = 300_000;

  test("N-1: does not fire when duration < threshold", () => {
    expect(checkSessionDuration(threshold - 1, threshold)).toBeNull();
  });

  test("N: does not fire when duration === threshold", () => {
    expect(checkSessionDuration(threshold, threshold)).toBeNull();
  });

  test("N+1: fires when duration > threshold", () => {
    const result = checkSessionDuration(threshold + 1, threshold);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "session_duration_exceeded",
      durationMs: threshold + 1,
      threshold,
    });
  });
});

// ---------------------------------------------------------------------------
// Issue 160: goal drift detection
// ---------------------------------------------------------------------------

describe("buildKeywordPatterns", () => {
  test("extracts meaningful words and creates RegExp patterns", () => {
    const patterns = buildKeywordPatterns(["search the web", "write files"]);
    // "the" is a stopword, "search", "web", "write", "files" should be extracted
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => p.test("search_tool"))).toBe(true);
    expect(patterns.some((p) => p.test("file_writer"))).toBe(true);
  });

  test("filters stopwords and short words", () => {
    const patterns = buildKeywordPatterns(["a an the to for in on of and or"]);
    // All are stopwords — nothing extracted
    expect(patterns.length).toBe(0);
  });

  test("deduplicates identical keywords across objectives", () => {
    const patterns = buildKeywordPatterns(["search data", "search results"]);
    const searchPatterns = patterns.filter((p) => p.toString().includes("search"));
    expect(searchPatterns.length).toBe(1);
  });

  test("returns empty array for empty objectives", () => {
    expect(buildKeywordPatterns([])).toEqual([]);
  });
});

describe("matchesAnyObjective", () => {
  test("returns true when toolId matches a pattern", () => {
    const patterns = buildKeywordPatterns(["search the web"]);
    expect(matchesAnyObjective("web_search", patterns)).toBe(true);
  });

  test("returns false when toolId does not match any pattern", () => {
    const patterns = buildKeywordPatterns(["search the web"]);
    expect(matchesAnyObjective("email_send", patterns)).toBe(false);
  });

  test("returns false when patterns is empty", () => {
    expect(matchesAnyObjective("any_tool", [])).toBe(false);
  });

  test("is case-insensitive", () => {
    const patterns = buildKeywordPatterns(["Search Data"]);
    expect(matchesAnyObjective("SEARCH_TOOL", patterns)).toBe(true);
  });
});

describe("checkGoalDrift", () => {
  const objectives = ["search the web", "write a report"];
  const threshold = 1.0;

  test("returns null when objectives is empty", () => {
    expect(checkGoalDrift(1.0, threshold, [])).toBeNull();
  });

  test("returns null when driftScore < threshold", () => {
    expect(checkGoalDrift(0.5, threshold, objectives)).toBeNull();
  });

  test("fires when driftScore === threshold (meets minimum)", () => {
    // Uses >= semantics: fire when score reaches the threshold
    const result = checkGoalDrift(threshold, threshold, objectives);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "goal_drift",
      driftScore: threshold,
      threshold,
      objectives,
    });
  });

  test("fires when driftScore > threshold", () => {
    const result = checkGoalDrift(1.0, 0.5, objectives);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      kind: "goal_drift",
      driftScore: 1.0,
      threshold: 0.5,
      objectives,
    });
  });

  test("fires at score 1.0 with default threshold 1.0 (fully drifted)", () => {
    // Default case: threshold=1.0 fires when all tools are off-target (score=1.0)
    const result = checkGoalDrift(1.0, 1.0, objectives);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("goal_drift");
  });
});
