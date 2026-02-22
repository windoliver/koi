import { normalize } from "../normalize.js";
import type { FusionStrategy, ScoreNormalizer, SearchResult } from "../types.js";

const DEFAULT_RRF_K = 60;

/** RRF: score = sum(1 / (k + rank)) per result list */
export function applyRrf(
  rankedLists: readonly (readonly SearchResult[])[],
  k: number,
  limit: number,
): readonly SearchResult[] {
  const scores = new Map<string, { score: number; result: SearchResult }>();

  for (const list of rankedLists) {
    let rank = 0;
    for (const result of list) {
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(result.id);
      if (existing) {
        scores.set(result.id, {
          score: existing.score + rrfScore,
          result: existing.result,
        });
      } else {
        scores.set(result.id, { score: rrfScore, result });
      }
      rank++;
    }
  }

  return sortAndLimit(scores, limit);
}

/** Weighted RRF: same as RRF but with per-list weights */
export function applyWeightedRrf(
  rankedLists: readonly (readonly SearchResult[])[],
  k: number,
  weights: readonly number[],
  limit: number,
): readonly SearchResult[] {
  const scores = new Map<string, { score: number; result: SearchResult }>();

  let listIdx = 0;
  for (const list of rankedLists) {
    const weight = weights[listIdx] ?? 1;
    let rank = 0;
    for (const result of list) {
      const rrfScore = weight / (k + rank + 1);
      const existing = scores.get(result.id);
      if (existing) {
        scores.set(result.id, {
          score: existing.score + rrfScore,
          result: existing.result,
        });
      } else {
        scores.set(result.id, { score: rrfScore, result });
      }
      rank++;
    }
    listIdx++;
  }

  return sortAndLimit(scores, limit);
}

/** Linear combination: score = sum(weight_i * normalized_score_i) */
export function applyLinear(
  rankedLists: readonly (readonly SearchResult[])[],
  weights: readonly number[],
  normalizer: ScoreNormalizer,
  limit: number,
): readonly SearchResult[] {
  const scores = new Map<string, { score: number; result: SearchResult }>();

  let listIdx = 0;
  for (const list of rankedLists) {
    const weight = weights[listIdx] ?? 1;
    const rawScores = list.map((r) => r.score);
    const normalized = normalize(rawScores, normalizer);

    let j = 0;
    for (const result of list) {
      const normScore = (normalized[j] ?? 0) * weight;
      const existing = scores.get(result.id);
      if (existing) {
        scores.set(result.id, {
          score: existing.score + normScore,
          result: existing.result,
        });
      } else {
        scores.set(result.id, { score: normScore, result });
      }
      j++;
    }
    listIdx++;
  }

  return sortAndLimit(scores, limit);
}

/** Dispatch to named fusion strategy */
export function applyFusion(
  strategy: FusionStrategy,
  rankedLists: readonly (readonly SearchResult[])[],
  limit: number,
): readonly SearchResult[] {
  switch (strategy.kind) {
    case "rrf":
      return applyRrf(rankedLists, strategy.k ?? DEFAULT_RRF_K, limit);
    case "weighted_rrf":
      return applyWeightedRrf(rankedLists, strategy.k ?? DEFAULT_RRF_K, strategy.weights, limit);
    case "linear":
      return applyLinear(rankedLists, strategy.weights, strategy.normalizer ?? "min_max", limit);
    case "custom":
      return strategy.fuse(rankedLists, limit);
  }
}

function sortAndLimit(
  scores: Map<string, { score: number; result: SearchResult }>,
  limit: number,
): readonly SearchResult[] {
  const entries = [...scores.values()];
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit).map((e) => ({
    ...e.result,
    score: e.score,
  }));
}
