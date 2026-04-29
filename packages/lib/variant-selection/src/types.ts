/**
 * Types for the variant selection subsystem.
 *
 * Generic over the variant value type so callers can attach any payload
 * (ToolHandler, BrickArtifact, etc.) to variant entries.
 */

import type { DegeneracyConfig, JsonObject } from "@koi/core";
import type { CircuitBreaker } from "@koi/errors";

/** A single variant in a pool with its computed fitness score. */
export interface VariantEntry<T> {
  readonly id: string;
  readonly value: T;
  /** Fitness score in [0, 1], computed via computeBrickFitness. */
  readonly fitnessScore: number;
}

/** A pool of degenerate variants for a single capability. */
export interface VariantPool<T> {
  readonly capability: string;
  readonly variants: readonly VariantEntry<T>[];
  readonly config: DegeneracyConfig;
}

/** Result of selecting a variant from a pool. */
export type VariantSelection<T> =
  | {
      readonly ok: true;
      readonly selected: VariantEntry<T>;
      readonly alternatives: readonly VariantEntry<T>[];
    }
  | { readonly ok: false; readonly reason: string };

/** Injectable context for selection strategies. */
export interface SelectionContext {
  readonly input?: JsonObject | undefined;
  readonly clock: () => number;
  readonly random: () => number;
}

/** Maps variant IDs to their circuit breakers. */
export type BreakerMap = ReadonlyMap<string, CircuitBreaker>;

/** User-provided function for context-match strategy. */
export type ContextMatcher<T> = (variant: VariantEntry<T>, input: JsonObject | undefined) => number;
