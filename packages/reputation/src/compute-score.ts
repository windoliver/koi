/**
 * Pure score computation: feedback entries → ReputationScore.
 *
 * Weighted average with configurable weights per FeedbackKind.
 * Level thresholds: <0.2 untrusted, <0.4 low, <0.6 medium, >=0.6 high.
 * "verified" is never auto-assigned — it requires external attestation.
 */

import type {
  AgentId,
  FeedbackKind,
  ReputationFeedback,
  ReputationLevel,
  ReputationScore,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Weight configuration
// ---------------------------------------------------------------------------

/** Default numeric weights for each FeedbackKind. */
export const DEFAULT_FEEDBACK_WEIGHTS: Readonly<Record<FeedbackKind, number>> = Object.freeze({
  positive: 1.0,
  neutral: 0.5,
  negative: 0.0,
} as const);

/** Thresholds for mapping a continuous score to a ReputationLevel. */
const LEVEL_THRESHOLDS: readonly { readonly min: number; readonly level: ReputationLevel }[] =
  Object.freeze([
    { min: 0.6, level: "high" },
    { min: 0.4, level: "medium" },
    { min: 0.2, level: "low" },
    { min: 0, level: "untrusted" },
  ] as const);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a ReputationScore from a set of feedback entries.
 *
 * Returns `undefined` when `entries` is empty (no data → unknown trust).
 * Callers should treat `undefined` as `"unknown"` level (fail-closed).
 */
export function computeScore(
  targetId: AgentId,
  entries: readonly ReputationFeedback[],
  weights?: Readonly<Record<FeedbackKind, number>>,
): ReputationScore | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const w = weights ?? DEFAULT_FEEDBACK_WEIGHTS;

  let sum = 0;
  for (const entry of entries) {
    const weight = w[entry.kind];
    sum += weight ?? 0;
  }
  const score = sum / entries.length;

  return {
    agentId: targetId,
    score,
    level: scoreToLevel(score),
    feedbackCount: entries.length,
    computedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scoreToLevel(score: number): ReputationLevel {
  for (const threshold of LEVEL_THRESHOLDS) {
    if (score >= threshold.min) {
      return threshold.level;
    }
  }
  return "untrusted";
}
