/**
 * Mutation pressure check — capability space lookup for forge governance.
 *
 * Queries active bricks in the same capability space (via tag matching),
 * computes the max fitness among them, and maps to a mutation pressure zone.
 * Returns MUTATION_PRESSURE_FROZEN error when high-fitness incumbents protect
 * the capability space.
 *
 * Fail-open: store errors allow the forge to proceed (don't block on infra failures).
 */

import type { BrickArtifact, BrickId, ForgeStore, MutationPressure, Result } from "@koi/core";
import { computeBrickFitness, computeMutationPressure } from "@koi/validation";
import type { MutationPressureConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { governanceError } from "./errors.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface MutationPressureResult {
  /** The computed mutation pressure zone. */
  readonly pressure: MutationPressure;
  /** Max fitness score among overlapping active bricks (0 if none). */
  readonly maxFitness: number;
  /** BrickId of the highest-fitness overlapping brick, if any. */
  readonly dominantBrickId: BrickId | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max bricks to scan for capability space overlap. */
const SEARCH_LIMIT = 50;

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Checks mutation pressure for a capability space defined by tags.
 *
 * Queries active bricks with overlapping tags, finds the highest fitness,
 * and maps to a pressure zone. Returns a governance error when the zone is "frozen".
 *
 * @param tags - Tags defining the capability space to check.
 * @param store - ForgeStore to query for overlapping bricks.
 * @param config - Mutation pressure thresholds.
 * @param nowMs - Current time in epoch ms (for fitness scoring).
 * @returns Ok with pressure result, or error if capability space is frozen.
 */
export async function checkMutationPressure(
  tags: readonly string[],
  store: ForgeStore,
  config: MutationPressureConfig,
  nowMs: number,
): Promise<Result<MutationPressureResult, ForgeError>> {
  // No tags = no capability space to check
  if (tags.length === 0) {
    return {
      ok: true,
      value: { pressure: "stable", maxFitness: 0, dominantBrickId: undefined },
    };
  }

  const searchResult = await store
    .search({
      tags,
      lifecycle: "active",
      limit: SEARCH_LIMIT,
      orderBy: "fitness",
    })
    .catch((): null => null);

  // Fail-open: store errors → allow forge to proceed
  if (searchResult === null || !searchResult.ok) {
    return {
      ok: true,
      value: { pressure: "stable", maxFitness: 0, dominantBrickId: undefined },
    };
  }

  const bricks = searchResult.value;

  const { maxFitness, dominantBrickId } = findMaxFitness(bricks, nowMs);

  // No bricks with usage data → no incumbents to protect the capability space
  if (dominantBrickId === undefined) {
    return {
      ok: true,
      value: { pressure: "stable", maxFitness: 0, dominantBrickId: undefined },
    };
  }

  const pressure = computeMutationPressure(maxFitness, {
    frozenThreshold: config.frozenThreshold,
    stableThreshold: config.stableThreshold,
    experimentalThreshold: config.experimentalThreshold,
  });

  if (pressure === "frozen") {
    return {
      ok: false,
      error: governanceError(
        "MUTATION_PRESSURE_FROZEN",
        `Capability space is protected by high-fitness brick ${String(dominantBrickId ?? "unknown")} (fitness: ${maxFitness.toFixed(3)})`,
      ),
    };
  }

  return {
    ok: true,
    value: { pressure, maxFitness, dominantBrickId },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MaxFitnessResult {
  readonly maxFitness: number;
  readonly dominantBrickId: BrickId | undefined;
}

/** Find the highest fitness score among bricks, skipping those with no usage data. */
function findMaxFitness(bricks: readonly BrickArtifact[], nowMs: number): MaxFitnessResult {
  let maxFitness = 0;
  let dominantBrickId: BrickId | undefined;

  for (const brick of bricks) {
    // Skip bricks with no usage data
    if (brick.fitness === undefined) continue;
    const totalCalls = brick.fitness.successCount + brick.fitness.errorCount;
    if (totalCalls === 0) continue;

    const fitness = computeBrickFitness(brick.fitness, nowMs);
    if (fitness > maxFitness) {
      maxFitness = fitness;
      dominantBrickId = brick.id;
    }
  }

  return { maxFitness, dominantBrickId };
}
