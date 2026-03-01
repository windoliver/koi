/**
 * Pure detection functions for forge demand triggers.
 *
 * Each heuristic is independently testable — no side effects, no state.
 * Follows the computeHealthAction pattern from tool-health.ts.
 */

import type { ForgeTrigger, ToolHealthSnapshot } from "@koi/core";

// ---------------------------------------------------------------------------
// Default capability gap regex patterns
// ---------------------------------------------------------------------------

/** Model response patterns indicating the LLM cannot find a suitable tool. */
export const DEFAULT_CAPABILITY_GAP_PATTERNS: readonly RegExp[] = [
  /I don'?t have (?:a |any )?tool/i,
  /no (?:available |suitable )?tool (?:for|to|that)/i,
  /I(?:'m| am) unable to .+ because .+ (?:tool|capability)/i,
  /I lack the (?:tool|capability|ability) to/i,
  /there (?:is|are) no (?:tool|function)s? (?:available )?(?:for|to)/i,
];

// ---------------------------------------------------------------------------
// Repeated failure detection
// ---------------------------------------------------------------------------

/**
 * Detect repeated failure demand when consecutive failures exceed threshold.
 *
 * @param toolId - The tool that is failing.
 * @param consecutiveFailures - Number of consecutive failures observed.
 * @param threshold - Minimum failures to trigger demand.
 * @returns ForgeTrigger if threshold met, undefined otherwise.
 */
export function detectRepeatedFailure(
  toolId: string,
  consecutiveFailures: number,
  threshold: number,
): ForgeTrigger | undefined {
  if (consecutiveFailures < threshold) return undefined;
  return {
    kind: "repeated_failure",
    toolName: toolId,
    count: consecutiveFailures,
  };
}

// ---------------------------------------------------------------------------
// Capability gap detection
// ---------------------------------------------------------------------------

/**
 * Detect capability gap from model response text matching known patterns.
 *
 * @param responseText - The model's text response.
 * @param patterns - Regex patterns indicating capability gaps.
 * @param gapCounts - Running count of gap detections per capability key.
 * @param threshold - Minimum occurrences before triggering.
 * @returns ForgeTrigger if gap detected and threshold met, undefined otherwise.
 */
export function detectCapabilityGap(
  responseText: string,
  patterns: readonly RegExp[],
  gapCounts: ReadonlyMap<string, number>,
  threshold: number,
): ForgeTrigger | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(responseText);
    if (match !== null) {
      const capability = match[0];
      const count = (gapCounts.get(capability) ?? 0) + 1;
      if (count >= threshold) {
        return {
          kind: "capability_gap",
          requiredCapability: capability,
        };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Latency degradation detection
// ---------------------------------------------------------------------------

/**
 * Detect latency degradation from health snapshot metrics.
 *
 * @param toolId - The tool to check.
 * @param healthSnapshot - Current health snapshot (undefined if not tracked).
 * @param p95ThresholdMs - Maximum acceptable average latency in ms.
 * @returns ForgeTrigger if degradation detected, undefined otherwise.
 */
export function detectLatencyDegradation(
  toolId: string,
  healthSnapshot: ToolHealthSnapshot | undefined,
  p95ThresholdMs: number,
): ForgeTrigger | undefined {
  if (healthSnapshot === undefined) return undefined;
  if (healthSnapshot.metrics.usageCount === 0) return undefined;
  if (healthSnapshot.metrics.avgLatencyMs <= p95ThresholdMs) return undefined;

  return {
    kind: "performance_degradation",
    toolName: toolId,
    metric: `avgLatencyMs=${String(Math.round(healthSnapshot.metrics.avgLatencyMs))}`,
  };
}
