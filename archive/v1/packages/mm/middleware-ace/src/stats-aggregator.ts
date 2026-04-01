/**
 * Curator — aggregates trajectory stats and produces curation candidates.
 */

import { computeCurationScore } from "./scoring.js";
import type { AggregatedStats, CurationCandidate } from "./types.js";

export interface CurateOptions {
  readonly scorer?: (
    stats: AggregatedStats,
    sessionCount: number,
    nowMs: number,
    lambda: number,
  ) => number;
  readonly minScore: number;
  readonly nowMs: number;
  readonly lambda: number;
}

/**
 * Produce curation candidates from aggregated stats.
 * Scores each identifier, filters by minScore, sorts descending.
 */
export function curateTrajectorySummary(
  stats: ReadonlyMap<string, AggregatedStats>,
  sessionCount: number,
  options: CurateOptions,
): readonly CurationCandidate[] {
  const scorer = options.scorer ?? computeCurationScore;
  const candidates: CurationCandidate[] = [];

  for (const [, stat] of stats) {
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
