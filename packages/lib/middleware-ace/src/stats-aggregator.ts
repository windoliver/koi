/**
 * Trajectory aggregation + curation candidate scoring.
 *
 * Pure functions: trajectory entries → per-identifier `AggregatedStats`,
 * then `AggregatedStats` → ranked `CurationCandidate[]`.
 */

import type { AggregatedStats, CurationCandidate, TrajectoryEntry } from "@koi/ace-types";

import { computeCurationScore } from "./scoring.js";

/** Identifier-keyed `AggregatedStats` map. */
export type StatsByIdentifier = ReadonlyMap<string, AggregatedStats>;

/**
 * Reduce trajectory entries into per-identifier aggregated stats.
 * Caller is responsible for providing entries from a single session.
 */
export function aggregateTrajectoryStats(entries: readonly TrajectoryEntry[]): StatsByIdentifier {
  const byId = new Map<string, AggregatedStats>();

  for (const entry of entries) {
    const key = `${entry.kind}:${entry.identifier}`;
    const prev = byId.get(key);
    const successInc = entry.outcome === "success" ? 1 : 0;
    const failureInc = entry.outcome === "failure" ? 1 : 0;
    const retryInc = entry.outcome === "retry" ? 1 : 0;

    if (prev === undefined) {
      byId.set(key, {
        identifier: entry.identifier,
        kind: entry.kind,
        successes: successInc,
        failures: failureInc,
        retries: retryInc,
        totalDurationMs: entry.durationMs,
        invocations: 1,
        lastSeenMs: entry.timestamp,
      });
      continue;
    }

    byId.set(key, {
      identifier: prev.identifier,
      kind: prev.kind,
      successes: prev.successes + successInc,
      failures: prev.failures + failureInc,
      retries: prev.retries + retryInc,
      totalDurationMs: prev.totalDurationMs + entry.durationMs,
      invocations: prev.invocations + 1,
      lastSeenMs: Math.max(prev.lastSeenMs, entry.timestamp),
    });
  }

  return byId;
}

/** Optional override hook for the curator's scoring function. */
export type CurationScorer = (
  stats: AggregatedStats,
  sessionCount: number,
  nowMs: number,
  lambda: number,
) => number;

export interface CurateOptions {
  readonly scorer?: CurationScorer;
  readonly minScore: number;
  readonly nowMs: number;
  readonly lambda: number;
}

/**
 * Score each identifier, filter by `minScore`, return descending by score.
 */
export function curateTrajectorySummary(
  stats: StatsByIdentifier,
  sessionCount: number,
  options: CurateOptions,
): readonly CurationCandidate[] {
  const scorer = options.scorer ?? computeCurationScore;
  const candidates: CurationCandidate[] = [];

  for (const stat of stats.values()) {
    const score = scorer(stat, sessionCount, options.nowMs, options.lambda);
    if (score >= options.minScore) {
      candidates.push({
        identifier: stat.identifier,
        kind: stat.kind,
        score,
        stats: stat,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}
