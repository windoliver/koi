/**
 * Curation scoring — frequency × success_rate × recency_decay.
 *
 * Pure functions: no IO, no clock dependency (caller passes `nowMs`).
 */

import type { AggregatedStats } from "@koi/ace-types";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Compute exponential recency decay factor. */
export function computeRecencyFactor(lastSeenMs: number, nowMs: number, lambda: number): number {
  const daysSince = Math.max(0, (nowMs - lastSeenMs) / MS_PER_DAY);
  return Math.exp(-lambda * daysSince);
}

/**
 * Compute curation score for an aggregated stat entry.
 *
 *   score = min(1, frequency × successRate × recency)
 *   - frequency = invocations / sessionCount
 *   - successRate = successes / invocations
 *   - recency = exp(-lambda × daysSince)
 */
export function computeCurationScore(
  stats: AggregatedStats,
  sessionCount: number,
  nowMs: number,
  lambda: number,
): number {
  if (stats.invocations === 0 || sessionCount === 0) return 0;
  const frequency = stats.invocations / sessionCount;
  const successRate = stats.successes / stats.invocations;
  const recency = computeRecencyFactor(stats.lastSeenMs, nowMs, lambda);
  return Math.min(1, frequency * successRate * recency);
}
