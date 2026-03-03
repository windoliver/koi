/**
 * Brick sorting — query-time ranking for search_forge results.
 *
 * Pure function. Computes fitness scores at query time (always fresh),
 * applies minFitnessScore filtering, and sorts by the requested orderBy.
 * Tiebreak: alphabetical by brick name.
 */

import type { BrickArtifactBase, ForgeQuery, TrailConfig } from "@koi/core";
import { DEFAULT_BRICK_FITNESS, DEFAULT_TRAIL_STRENGTH } from "@koi/core";
import type { FitnessScoringConfig } from "./fitness-scoring.js";
import { computeBrickFitness } from "./fitness-scoring.js";
import { computeEffectiveTrailStrength } from "./trail-strength.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SortBricksOptions {
  readonly nowMs: number;
  readonly fitnessConfig?: Partial<FitnessScoringConfig>;
  readonly trailConfig?: Partial<TrailConfig>;
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

  // Pre-compute fitness + trail strength scores for each brick
  const scored = bricks.map((brick) => {
    // Compute effective trail strength with lazy decay at query time
    const storedTrail = brick.trailStrength ?? DEFAULT_TRAIL_STRENGTH;
    const lastUsedAt = brick.fitness?.lastUsedAt ?? 0;
    const trailElapsed = lastUsedAt > 0 ? options.nowMs - lastUsedAt : 0;

    return {
      brick,
      fitness: computeBrickFitness(
        brick.fitness ?? DEFAULT_BRICK_FITNESS,
        options.nowMs,
        options.fitnessConfig,
      ),
      effectiveTrail: computeEffectiveTrailStrength(storedTrail, trailElapsed, options.trailConfig),
    };
  });

  // Apply minFitnessScore filter
  const minScore = query.minFitnessScore;
  const afterFitness =
    minScore !== undefined && minScore > 0
      ? scored.filter((entry) => entry.fitness >= minScore)
      : scored;

  // Apply minTrailStrength filter
  const minTrail = query.minTrailStrength;
  const filtered =
    minTrail !== undefined && minTrail > 0
      ? afterFitness.filter((entry) => entry.effectiveTrail >= minTrail)
      : afterFitness;

  // Sort by orderBy with tiebreak on name
  const sorted = [...filtered].sort((a, b) => {
    const primary = comparePrimary(a, b, orderBy);
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
  readonly effectiveTrail: number;
}

function comparePrimary(
  a: ScoredBrick,
  b: ScoredBrick,
  orderBy: "fitness" | "recency" | "usage" | "trailStrength",
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

    case "trailStrength":
      return b.effectiveTrail - a.effectiveTrail; // descending (strongest trail first)
  }
}
