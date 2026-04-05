/**
 * Salience scoring — exponential decay and composite relevance scoring
 * for memory recall. Pure functions, zero I/O.
 */

import type { MemoryType } from "@koi/core";
import type { ScannedMemory } from "./scan.js";

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** Configuration for the exponential decay function. */
export interface DecayConfig {
  /** Half-life in days. Default: 30. */
  readonly halfLifeDays?: number | undefined;
}

/** Per-type relevance weights. Higher = more relevant. */
export interface TypeRelevanceWeights {
  readonly user?: number | undefined;
  readonly feedback?: number | undefined;
  readonly project?: number | undefined;
  readonly reference?: number | undefined;
}

/** Configuration for the salience scoring pipeline. */
export interface SalienceConfig {
  readonly decay?: DecayConfig | undefined;
  readonly typeWeights?: TypeRelevanceWeights | undefined;
  /** Minimum salience score (prevents zero-collapse). Default: 0.1. */
  readonly salienceFloor?: number | undefined;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A memory scored and ready for budget selection. */
export interface ScoredMemory {
  readonly memory: ScannedMemory;
  readonly salienceScore: number;
  readonly decayScore: number;
  readonly typeRelevance: number;
  /** Reserved for stale memory detection (deferred). */
  readonly stale?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_SALIENCE_FLOOR = 0.1;
const MS_PER_DAY = 86_400_000;

const DEFAULT_TYPE_WEIGHTS: Readonly<Record<MemoryType, number>> = {
  user: 1.0,
  feedback: 1.2,
  project: 1.0,
  reference: 0.8,
} as const;

// ---------------------------------------------------------------------------
// Pure scoring functions
// ---------------------------------------------------------------------------

/**
 * Computes exponential decay score based on time since last update.
 *
 * Formula: exp(-lambda * ageDays) where lambda = ln(2) / halfLifeDays.
 * Returns a value in [0, 1]. Future timestamps clamp to 1.0.
 */
export function computeDecayScore(
  updatedAt: number,
  now: number,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  const ageDays = Math.max(0, (now - updatedAt) / MS_PER_DAY);
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

/**
 * Returns the type-based relevance weight for a memory type.
 * Falls back to 1.0 for types not present in the weights map.
 */
export function computeTypeRelevance(type: MemoryType, weights?: TypeRelevanceWeights): number {
  if (weights === undefined) return DEFAULT_TYPE_WEIGHTS[type];
  return weights[type] ?? 1.0;
}

/**
 * Computes the composite salience score.
 * Result is `max(decayScore * typeRelevance, floor)`.
 */
export function computeSalience(
  decayScore: number,
  typeRelevance: number,
  floor: number = DEFAULT_SALIENCE_FLOOR,
): number {
  return Math.max(decayScore * typeRelevance, floor);
}

/**
 * Scores and sorts an array of scanned memories by salience (descending).
 *
 * When `MemoryRecord` gains an `accessCount` field in the future, the
 * formula will become: `typeRelevance * log(accessCount + 2) * decayScore`.
 */
export function scoreMemories(
  memories: readonly ScannedMemory[],
  config?: SalienceConfig,
  now?: number,
): readonly ScoredMemory[] {
  const timestamp = now ?? Date.now();
  const halfLifeDays = config?.decay?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const floor = config?.salienceFloor ?? DEFAULT_SALIENCE_FLOOR;

  const scored = memories.map((memory): ScoredMemory => {
    const decayScore = computeDecayScore(memory.record.updatedAt, timestamp, halfLifeDays);
    const typeRelevance = computeTypeRelevance(memory.record.type, config?.typeWeights);
    const salienceScore = computeSalience(decayScore, typeRelevance, floor);
    return { memory, salienceScore, decayScore, typeRelevance };
  });

  return scored.toSorted((a, b) => b.salienceScore - a.salienceScore);
}
