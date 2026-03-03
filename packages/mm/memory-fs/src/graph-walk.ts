/**
 * BFS expansion over causal edges within a single entity's fact set.
 *
 * Used by recall() to expand initial retrieval seeds along causal
 * parent/child links with exponential score decay per hop.
 */

import type { MemoryFact } from "./types.js";

/** Default exponential decay factor per hop. */
export const DEFAULT_GRAPH_DECAY_FACTOR = 0.8;

export interface GraphWalkConfig {
  readonly maxHops: number;
  readonly decayFactor: number;
}

export interface GraphWalkResult {
  readonly fact: MemoryFact;
  readonly hops: number;
  readonly score: number; // baseScore * (decayFactor ^ hops)
}

/**
 * BFS expansion over causal edges within a single entity's fact set.
 * Returns graph-expanded results with decayed scores.
 *
 * Algorithm:
 * 1. Build id→fact lookup from allFacts
 * 2. BFS from seed IDs, tracking visited set (cycle detection)
 * 3. Each hop applies exponential decay: score * (decayFactor ^ hops)
 * 4. Dedup: if a fact is both a seed and reachable via graph, keep higher score
 */
export function expandCausalGraph(
  seeds: ReadonlyArray<{ readonly fact: MemoryFact; readonly score: number }>,
  allFacts: readonly MemoryFact[],
  config: GraphWalkConfig,
): readonly GraphWalkResult[] {
  const { maxHops, decayFactor } = config;

  // Build id→fact lookup (decision 15A: per-recall, no cache)
  const factById = new Map<string, MemoryFact>();
  for (const f of allFacts) {
    factById.set(f.id, f);
  }

  // Track best score per fact ID (dedup: higher score wins)
  const bestScores = new Map<string, GraphWalkResult>();

  function upsert(fact: MemoryFact, hops: number, score: number): void {
    const existing = bestScores.get(fact.id);
    if (existing === undefined || score > existing.score) {
      bestScores.set(fact.id, { fact, hops, score });
    }
  }

  // Initialize with seeds (hops=0, original score)
  for (const seed of seeds) {
    upsert(seed.fact, 0, seed.score);
  }

  // BFS queue: [factId, currentHops, baseScore]
  const queue: Array<{ readonly id: string; readonly hops: number; readonly score: number }> = [];
  const visited = new Set<string>();

  for (const seed of seeds) {
    visited.add(seed.fact.id);
    if (maxHops > 0) {
      queue.push({ id: seed.fact.id, hops: 0, score: seed.score });
    }
  }

  // BFS expansion
  // let — queue index for iteration
  let qi = 0;
  while (qi < queue.length) {
    const current = queue[qi];
    if (current === undefined) break;
    qi++;

    const nextHops = current.hops + 1;
    if (nextHops > maxHops) continue;

    const fact = factById.get(current.id);
    if (fact === undefined) continue;

    // Collect neighbors: both parents and children
    const neighborIds: readonly string[] = [
      ...(fact.causalParents ?? []),
      ...(fact.causalChildren ?? []),
    ];

    for (const neighborId of neighborIds) {
      const neighbor = factById.get(neighborId);
      if (neighbor === undefined) continue; // orphan reference — skip gracefully

      const neighborScore = current.score * decayFactor;
      upsert(neighbor, nextHops, neighborScore);

      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        queue.push({ id: neighborId, hops: nextHops, score: neighborScore });
      }
    }
  }

  return [...bestScores.values()];
}
