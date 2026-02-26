/**
 * Pure detection functions — each returns an AnomalyDetail or null.
 *
 * No side effects. No session state. All state is passed as arguments.
 */

import type { LatencyStats } from "./types.js";

type ToolRateExceeded = {
  readonly kind: "tool_rate_exceeded";
  readonly callsPerTurn: number;
  readonly threshold: number;
};

type ErrorSpike = {
  readonly kind: "error_spike";
  readonly errorCount: number;
  readonly threshold: number;
};

type ToolRepeated = {
  readonly kind: "tool_repeated";
  readonly toolId: string;
  readonly repeatCount: number;
  readonly threshold: number;
};

type ModelLatencyAnomaly = {
  readonly kind: "model_latency_anomaly";
  readonly latencyMs: number;
  readonly mean: number;
  readonly stddev: number;
  readonly factor: number;
};

type DeniedToolCalls = {
  readonly kind: "denied_tool_calls";
  readonly deniedCount: number;
  readonly threshold: number;
};

/**
 * Signal 1: Too many tool calls in a single turn.
 */
export function checkToolRate(callsPerTurn: number, threshold: number): ToolRateExceeded | null {
  if (callsPerTurn > threshold) {
    return { kind: "tool_rate_exceeded", callsPerTurn, threshold };
  }
  return null;
}

/**
 * Signal 2: Too many error calls accumulated in the session.
 */
export function checkErrorSpike(totalErrors: number, threshold: number): ErrorSpike | null {
  if (totalErrors > threshold) {
    return { kind: "error_spike", errorCount: totalErrors, threshold };
  }
  return null;
}

/**
 * Signal 3: Same tool called consecutively beyond threshold.
 *
 * Returns the new consecutiveCount after this call.
 * (consecutiveCount tracking is done by caller, passed in as current value)
 */
export function checkToolRepeat(
  toolId: string,
  consecutiveCount: number,
  threshold: number,
): ToolRepeated | null {
  if (consecutiveCount > threshold) {
    return { kind: "tool_repeated", toolId, repeatCount: consecutiveCount, threshold };
  }
  return null;
}

/**
 * Signal 4: Model call latency exceeds mean + factor * stddev.
 * Only fires after minSamples have been collected (warmup guard).
 */
export function checkLatencyAnomaly(
  latencyMs: number,
  stats: LatencyStats,
  factor: number,
  minSamples: number,
): ModelLatencyAnomaly | null {
  if (stats.count < minSamples) return null;
  if (stats.stddev === 0) return null;
  const upperBound = stats.mean + factor * stats.stddev;
  if (latencyMs > upperBound) {
    return {
      kind: "model_latency_anomaly",
      latencyMs,
      mean: stats.mean,
      stddev: stats.stddev,
      factor,
    };
  }
  return null;
}

/**
 * Signal 5: Too many tool calls denied by permissions.
 */
export function checkDeniedCalls(deniedCount: number, threshold: number): DeniedToolCalls | null {
  if (deniedCount > threshold) {
    return { kind: "denied_tool_calls", deniedCount, threshold };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gap signals (6–8)
// ---------------------------------------------------------------------------

type IrreversibleActionRate = {
  readonly kind: "irreversible_action_rate";
  readonly toolId: string;
  readonly callsThisTurn: number;
  readonly threshold: number;
};

type TokenSpike = {
  readonly kind: "token_spike";
  readonly outputTokens: number;
  readonly mean: number;
  readonly stddev: number;
  readonly factor: number;
};

type ToolDiversitySpike = {
  readonly kind: "tool_diversity_spike";
  readonly distinctToolCount: number;
  readonly threshold: number;
};

/**
 * Gap 1: Destructive/irreversible tool called too many times this turn.
 * Caller is responsible for only passing calls whose toolId is in the
 * configured destructiveToolIds set.
 */
export function checkDestructiveRate(
  toolId: string,
  callsThisTurn: number,
  threshold: number,
): IrreversibleActionRate | null {
  if (callsThisTurn > threshold) {
    return { kind: "irreversible_action_rate", toolId, callsThisTurn, threshold };
  }
  return null;
}

/**
 * Gap 2: Output token count is a statistical outlier (mean + factor * stddev).
 * Reuses LatencyStats shape and the same warmup guard as latency.
 */
export function checkTokenSpike(
  outputTokens: number,
  stats: LatencyStats,
  factor: number,
  minSamples: number,
): TokenSpike | null {
  if (stats.count < minSamples) return null;
  if (stats.stddev === 0) return null;
  const upperBound = stats.mean + factor * stats.stddev;
  if (outputTokens > upperBound) {
    return {
      kind: "token_spike",
      outputTokens,
      mean: stats.mean,
      stddev: stats.stddev,
      factor,
    };
  }
  return null;
}

/**
 * Gap 3: Too many distinct tools called in a single turn (sweep behaviour).
 */
export function checkToolDiversity(
  distinctToolCount: number,
  threshold: number,
): ToolDiversitySpike | null {
  if (distinctToolCount > threshold) {
    return { kind: "tool_diversity_spike", distinctToolCount, threshold };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gap A + Gap B signals (9–10)
// ---------------------------------------------------------------------------

type ToolPingPong = {
  readonly kind: "tool_ping_pong";
  readonly toolIdA: string;
  readonly toolIdB: string;
  readonly altCount: number;
  readonly threshold: number;
};

type SessionDurationExceeded = {
  readonly kind: "session_duration_exceeded";
  readonly durationMs: number;
  readonly threshold: number;
};

// ---------------------------------------------------------------------------
// Phase 2 signal (11)
// ---------------------------------------------------------------------------

type DelegationDepthExceeded = {
  readonly kind: "delegation_depth_exceeded";
  readonly currentDepth: number;
  readonly maxDepth: number;
  readonly spawnToolId: string;
};

/**
 * Phase 2: Agent at currentDepth called a spawn tool when depth >= maxDepth.
 * Fire condition: currentDepth >= maxDepth, meaning the spawned child would
 * land at depth currentDepth + 1 > maxDepth (consistent with other > threshold semantics).
 */
export function checkDelegationDepth(
  currentDepth: number,
  spawnToolId: string,
  maxDepth: number,
): DelegationDepthExceeded | null {
  if (currentDepth >= maxDepth) {
    return { kind: "delegation_depth_exceeded", currentDepth, maxDepth, spawnToolId };
  }
  return null;
}

/**
 * Gap A: Agent alternates between exactly two tools beyond threshold.
 * altCount is the number of A↔B transitions observed so far.
 */
export function checkToolPingPong(
  toolIdA: string,
  toolIdB: string,
  altCount: number,
  threshold: number,
): ToolPingPong | null {
  if (altCount > threshold) {
    return { kind: "tool_ping_pong", toolIdA, toolIdB, altCount, threshold };
  }
  return null;
}

/**
 * Gap B: Session wall-clock duration exceeds the configured limit.
 * Caller is responsible for firing this at most once per session.
 */
export function checkSessionDuration(
  durationMs: number,
  threshold: number,
): SessionDurationExceeded | null {
  if (durationMs > threshold) {
    return { kind: "session_duration_exceeded", durationMs, threshold };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issue 160: Goal drift detection
// ---------------------------------------------------------------------------

type GoalDrift = {
  readonly kind: "goal_drift";
  readonly driftScore: number;
  readonly threshold: number;
  readonly objectives: readonly string[];
};

const STOPWORDS = new Set(["a", "an", "the", "to", "for", "in", "on", "of", "and", "or"]);

/**
 * Pre-compile keyword patterns from objectives at factory time.
 * Extracts meaningful words (length > 2, not stopwords) and deduplicates.
 */
export function buildKeywordPatterns(objectives: readonly string[]): readonly RegExp[] {
  const words = objectives.flatMap((obj) =>
    obj
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
  return [...new Set(words)].map((w) => new RegExp(w, "i"));
}

/**
 * Check if a single tool ID matches any pre-compiled objective keyword pattern.
 */
export function matchesAnyObjective(toolId: string, patterns: readonly RegExp[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((p) => p.test(toolId));
}

/**
 * Pure check: fire if driftScore meets or exceeds threshold and objectives are declared.
 *
 * Uses >= so that threshold=1.0 fires when 100% of tools are off-target (score=1.0).
 * This differs from other anomaly checks (which use >) because drift is a fraction:
 * the threshold is the minimum score that constitutes an anomaly.
 */
export function checkGoalDrift(
  driftScore: number,
  threshold: number,
  objectives: readonly string[],
): GoalDrift | null {
  if (objectives.length === 0) return null;
  if (driftScore >= threshold) return { kind: "goal_drift", driftScore, threshold, objectives };
  return null;
}
