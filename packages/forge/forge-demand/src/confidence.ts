/**
 * Confidence scoring for forge demand signals.
 *
 * Pure function — no side effects, no state. Computes a normalized
 * confidence score (0-1) based on trigger kind, severity, and weights.
 */

import type { ForgeTrigger } from "@koi/core";
import type { ConfidenceWeights } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default confidence weights — repeated failure is strongest signal. */
export const DEFAULT_CONFIDENCE_WEIGHTS: ConfidenceWeights = {
  repeatedFailure: 0.9,
  capabilityGap: 0.8,
  performanceDegradation: 0.6,
} as const;

// ---------------------------------------------------------------------------
// Context for scoring
// ---------------------------------------------------------------------------

/** Additional context for confidence computation. */
export interface DemandContext {
  /** Number of failures observed for the trigger. */
  readonly failureCount: number;
  /** Heuristic threshold that was exceeded. */
  readonly threshold: number;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute confidence score for a forge demand trigger.
 *
 * Score = baseWeight * severity multiplier, clamped to [0, 1].
 * Severity = min(failureCount / threshold, 2) — caps at 2x threshold overshoot.
 *
 * @param trigger - The detected trigger.
 * @param weights - Weight distribution per trigger kind.
 * @param context - Additional scoring context.
 * @returns Confidence score between 0 and 1.
 */
export function computeDemandConfidence(
  trigger: ForgeTrigger,
  weights: ConfidenceWeights,
  context: DemandContext,
): number {
  const baseWeight = getBaseWeight(trigger.kind, weights);
  const severity =
    context.threshold > 0 ? Math.min(context.failureCount / context.threshold, 2) : 1;
  return Math.min(baseWeight * severity, 1);
}

function getBaseWeight(kind: ForgeTrigger["kind"], weights: ConfidenceWeights): number {
  switch (kind) {
    case "repeated_failure":
      return weights.repeatedFailure;
    case "capability_gap":
    case "no_matching_tool":
      return weights.capabilityGap;
    case "performance_degradation":
    case "agent_latency_degradation":
      return weights.performanceDegradation;
    case "agent_capability_gap":
      return weights.capabilityGap;
    case "agent_repeated_failure":
      return weights.repeatedFailure;
    // Success-side signals — moderate confidence (skill proposals, not urgent)
    case "complex_task_completed":
    case "novel_workflow":
      return 0.5;
    case "user_correction":
      return 0.7;
  }
  // Exhaustiveness guard — compiler errors if a trigger kind is missing above
  const _exhaustive: never = kind;
  return _exhaustive;
}
