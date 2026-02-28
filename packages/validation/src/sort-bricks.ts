/**
 * Brick sorting — query-time ranking for search_forge results.
 *
 * Pure function. Computes fitness scores at query time (always fresh),
 * applies minFitnessScore filtering, and sorts by the requested orderBy.
 * Tiebreak: alphabetical by brick name.
 */

import type { BrickArtifactBase, ForgeQuery } from "@koi/core";
import { DEFAULT_BRICK_FITNESS } from "@koi/core";
import type { FitnessScoringConfig } from "./fitness-scoring.js";
import { computeBrickFitness } from "./fitness-scoring.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SortBricksOptions {
  readonly nowMs: number;
  readonly fitnessConfig?: Partial<FitnessScoringConfig>;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Sorts and optionally filters bricks based on ForgeQuery ordering options.
 *
 * - Computes fitness per brick at query time (no stale cached scores).
 * - Filters by `minFitnessScore` if specified in the query.
 * - Sorts by `orderBy` (default: `"fitness"`).
 * - Tiebreak: alphabetical by `brick.name`.
 * - Returns a new array — never mutates the input.
 */
export function sortBricks<T extends BrickArtifactBase>(
  bricks: readonly T[],
  query: ForgeQuery,
  options: SortBricksOptions,
): readonly T[] {
  const orderBy = query.orderBy ?? "fitness";

  // Pre-compute fitness scores for each brick
  const scored = bricks.map((brick) => ({
    brick,
    fitness: computeBrickFitness(
      brick.fitness ?? DEFAULT_BRICK_FITNESS,
      options.nowMs,
      options.fitnessConfig,
    ),
  }));

  // Apply minFitnessScore filter
  const minScore = query.minFitnessScore;
  const filtered =
    minScore !== undefined && minScore > 0
      ? scored.filter((entry) => entry.fitness >= minScore)
      : scored;

  // Sort by orderBy with tiebreak on name
  const sorted = [...filtered].sort((a, b) => {
    const primary = comparePrimary(a, b, orderBy, options.nowMs);
    if (primary !== 0) return primary;
    return a.brick.name.localeCompare(b.brick.name);
  });

  return sorted.map((entry) => entry.brick);
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

interface ScoredBrick {
  readonly brick: BrickArtifactBase;
  readonly fitness: number;
}

function comparePrimary(
  a: ScoredBrick,
  b: ScoredBrick,
  orderBy: "fitness" | "recency" | "usage",
  _nowMs: number,
): number {
  switch (orderBy) {
    case "fitness":
      return b.fitness - a.fitness; // descending

    case "recency": {
      const aTime = a.brick.fitness?.lastUsedAt ?? 0;
      const bTime = b.brick.fitness?.lastUsedAt ?? 0;
      return bTime - aTime; // descending (most recent first)
    }

    case "usage": {
      const aUsage = a.brick.usageCount;
      const bUsage = b.brick.usageCount;
      return bUsage - aUsage; // descending (most used first)
    }
  }
}
