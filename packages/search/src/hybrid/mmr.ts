import { defaultTokenize } from "../bm25/bm25-index.js";
import type { SearchResult } from "../types.js";

export interface MmrConfig {
  /** 0 = max diversity, 1 = max relevance. Default 0.7 */
  readonly lambda: number;
}

const DEFAULT_LAMBDA = 0.7;

/**
 * Maximal Marginal Relevance re-ranking.
 *
 * Iteratively selects results that balance relevance (score) with diversity
 * (low similarity to already-selected results). Uses Jaccard token similarity
 * for fast, interpretable overlap measurement.
 *
 * MMR(d) = λ * relevance(d) - (1 - λ) * max_similarity(d, selected)
 */
export function applyMmr(
  results: readonly SearchResult[],
  limit: number,
  config?: Partial<MmrConfig>,
): readonly SearchResult[] {
  if (results.length <= 1) return results.slice(0, limit);

  const lambda = config?.lambda ?? DEFAULT_LAMBDA;

  // Pre-tokenize all results for Jaccard computation
  const tokenSets = results.map((r) => new Set(defaultTokenize(r.content)));

  // Normalize scores to [0, 1] for fair MMR balancing
  const maxScore = results.reduce((max, r) => Math.max(max, r.score), 0);
  const normScores = maxScore > 0 ? results.map((r) => r.score / maxScore) : results.map(() => 1);

  const selected: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

  // First pick: highest relevance
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (const idx of remaining) {
    const s = normScores[idx] ?? 0;
    if (s > bestScore) {
      bestScore = s;
      bestIdx = idx;
    }
  }
  selected.push(bestIdx);
  remaining.delete(bestIdx);

  // Iteratively pick by MMR score
  while (selected.length < limit && remaining.size > 0) {
    let mmrBestIdx = -1;
    let mmrBestScore = -Infinity;

    for (const candidateIdx of remaining) {
      const relevance = normScores[candidateIdx] ?? 0;
      const candidateTokens = tokenSets[candidateIdx];
      if (candidateTokens === undefined) continue;

      // Max similarity to any already-selected result
      let maxSim = 0;
      for (const selectedIdx of selected) {
        const selectedTokens = tokenSets[selectedIdx];
        if (selectedTokens === undefined) continue;
        const sim = jaccardSimilarity(candidateTokens, selectedTokens);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > mmrBestScore) {
        mmrBestScore = mmrScore;
        mmrBestIdx = candidateIdx;
      }
    }

    if (mmrBestIdx === -1) break;
    selected.push(mmrBestIdx);
    remaining.delete(mmrBestIdx);
  }

  return selected.map((idx) => results[idx]).filter((r): r is SearchResult => r !== undefined);
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B| */
function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
