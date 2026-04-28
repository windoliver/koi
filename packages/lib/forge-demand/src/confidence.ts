/**
 * Confidence scoring for forge demand signals.
 *
 * Pure: no state, no side effects. Computes a normalized confidence score
 * (0-1) from trigger kind, severity, and weights.
 */

import type { ForgeTrigger } from "@koi/core";
import type { ConfidenceWeights } from "./types.js";

/** Default confidence weights — repeated failure is the strongest signal. */
export const DEFAULT_CONFIDENCE_WEIGHTS: ConfidenceWeights = {
  repeatedFailure: 0.9,
  capabilityGap: 0.8,
  performanceDegradation: 0.6,
} as const;

/** Additional context for confidence computation. */
export interface DemandContext {
  /** Number of failures observed for the trigger. */
  readonly failureCount: number;
  /** Heuristic threshold that was exceeded. */
  readonly threshold: number;
}

/**
 * Compute confidence for a demand trigger.
 *
 * `score = baseWeight * severity`, clamped to `[0, 1]`.
 * `severity = min(failureCount / threshold, 2)` — caps at 2x overshoot.
 *
 * Deterministic: same inputs always produce the same score.
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
    case "agent_repeated_failure":
      return weights.repeatedFailure;
    case "capability_gap":
    case "no_matching_tool":
    case "agent_capability_gap":
    case "composition_gap":
      return weights.capabilityGap;
    case "performance_degradation":
    case "agent_latency_degradation":
      return weights.performanceDegradation;
    case "user_correction":
      return 0.7;
    case "complex_task_completed":
    case "novel_workflow":
      return 0.5;
    case "data_source_detected":
      return 0.9;
    case "data_source_gap":
      return 0.6;
  }
}
