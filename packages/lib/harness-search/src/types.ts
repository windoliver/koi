/**
 * Types for @koi/harness-search.
 *
 * harness-search runs the bounded refinement loop over synthesized
 * variants. Single-candidate synthesis itself lives in @koi/harness-synth;
 * this package owns the outer search/refinement loop only.
 */

import type { ToolDescriptor } from "@koi/core";

// ---------------------------------------------------------------------------
// Search node — a single code variant evaluated during the search
// ---------------------------------------------------------------------------

/** A single synthesized variant with its evaluation result. */
export interface SearchNode {
  readonly id: string;
  readonly code: string;
  readonly descriptor: ToolDescriptor;
  /** Iteration index (0 = initial, 1+ = refinements). */
  readonly iteration: number;
  /** Success rate from evaluation (0..1). null if evaluation never produced a value. */
  readonly successRate: number | null;
  /** Number of evaluation samples backing `successRate`. */
  readonly evalSamples: number;
  /** Parent node id (null for root). */
  readonly parentId: string | null;
  /** Wall-clock timestamp from `clock()`. */
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Result of evaluating a variant. */
export interface EvalResult {
  readonly successRate: number;
  readonly sampleCount: number;
  readonly failures: readonly EvalFailure[];
}

/** A single evaluation failure — fed back into the refine callback. */
export interface EvalFailure {
  readonly toolName: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Callbacks (caller-injected; harness-search owns no I/O)
// ---------------------------------------------------------------------------

/**
 * Refine existing code given new failures. Returns the next candidate
 * source — typically wraps an LLM call. The signal aborts when the
 * search is cancelled; abort-aware adapters MUST honor it.
 */
export type RefineCallback = (
  currentCode: string,
  failures: readonly EvalFailure[],
  iteration: number,
  maxIterations: number,
  signal: AbortSignal,
) => Promise<string>;

/**
 * Evaluate a variant against test scenarios. Typically wraps a verifier
 * + eval framework. Returns a success rate plus failures for the next
 * refinement.
 */
export type EvaluateCallback = (
  code: string,
  descriptor: ToolDescriptor,
  signal: AbortSignal,
) => Promise<EvalResult>;

// ---------------------------------------------------------------------------
// Search config
// ---------------------------------------------------------------------------

export interface SearchConfig {
  readonly refine: RefineCallback;
  readonly evaluate: EvaluateCallback;
  /** Hard cap on iterations. Default 20. Must be >= 1. */
  readonly maxIterations: number;
  /** Success rate at/above which a node counts as converged. Default 1.0. */
  readonly convergenceThreshold: number;
  /** Minimum samples required before convergence is trusted. Default 5. */
  readonly minEvalSamples: number;
  /** Stop after N consecutive iterations without strict improvement. Default 3. */
  readonly noImprovementLimit: number;
  /** Wall-clock source. Default Date.now. */
  readonly clock: () => number;
  /** PRNG. Default Math.random. */
  readonly random: () => number;
  /** Optional caller cancellation; aborts between iterations. */
  readonly signal?: AbortSignal | undefined;
}

/** Defaults applied when fields are omitted from a partial config. */
export const DEFAULT_SEARCH_CONFIG: Pick<
  SearchConfig,
  | "maxIterations"
  | "convergenceThreshold"
  | "minEvalSamples"
  | "noImprovementLimit"
  | "clock"
  | "random"
> = Object.freeze({
  maxIterations: 20,
  convergenceThreshold: 1.0,
  minEvalSamples: 5,
  noImprovementLimit: 3,
  clock: Date.now,
  random: Math.random,
});

// ---------------------------------------------------------------------------
// Search result
// ---------------------------------------------------------------------------

/** Why the search stopped. Stable identifiers for routing/telemetry. */
export type StopReason =
  | "converged"
  | "budget_exhausted"
  | "thompson_deploy"
  | "no_improvement"
  | "eval_failed"
  | "refine_failed"
  | "aborted";

export interface SearchResult {
  /** Best variant found across the search. */
  readonly best: SearchNode;
  /** All variants evaluated, in iteration order. */
  readonly history: readonly SearchNode[];
  readonly stopReason: StopReason;
  /** Number of evaluation cycles completed (== history.length). */
  readonly totalIterations: number;
  /** Whether `best` met both convergence gates. */
  readonly converged: boolean;
}
