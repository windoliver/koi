/**
 * Types for the harness search pipeline.
 *
 * harness-search runs iterative refinement over synthesized middleware
 * variants using Thompson sampling for the continue/deploy decision.
 */

import type { ToolDescriptor } from "@koi/core";

// ---------------------------------------------------------------------------
// Search node — a single code variant in the refinement chain
// ---------------------------------------------------------------------------

/** A single synthesized middleware variant with evaluation results. */
export interface SearchNode {
  readonly id: string;
  readonly code: string;
  readonly descriptor: ToolDescriptor;
  /** Iteration number (0 = initial synthesis, 1+ = refinements). */
  readonly iteration: number;
  /** Success rate from evaluation (0-1). null if not yet evaluated. */
  readonly successRate: number | null;
  /** Number of evaluation samples. */
  readonly evalSamples: number;
  /** Parent node ID (null for root). */
  readonly parentId: string | null;
  /** Timestamp of creation. */
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Result of evaluating a middleware variant. */
export interface EvalResult {
  readonly successRate: number;
  readonly sampleCount: number;
  readonly failures: readonly EvalFailure[];
}

/** A single evaluation failure — used as refinement input. */
export interface EvalFailure {
  readonly toolName: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Callbacks (injected by L3 wiring)
// ---------------------------------------------------------------------------

/**
 * Refine existing code given new failures.
 * Provided by L3 wiring — typically calls harness-synth's buildRefinementPrompt + LLM.
 */
export type RefineCallback = (
  currentCode: string,
  failures: readonly EvalFailure[],
  iteration: number,
  maxIterations: number,
) => Promise<string>;

/**
 * Evaluate a middleware variant against test scenarios.
 * Provided by L3 wiring — typically calls forge-verifier + eval framework.
 */
export type EvaluateCallback = (code: string, descriptor: ToolDescriptor) => Promise<EvalResult>;

// ---------------------------------------------------------------------------
// Search config
// ---------------------------------------------------------------------------

export interface SearchConfig {
  /** Refine callback (LLM + prompt). */
  readonly refine: RefineCallback;
  /** Evaluate callback (verifier + eval). */
  readonly evaluate: EvaluateCallback;
  /** Maximum iterations per search. Default: 20. */
  readonly maxIterations: number;
  /** Success rate threshold to consider converged. Default: 1.0 (100%). */
  readonly convergenceThreshold: number;
  /** Minimum evaluation samples before trusting success rate. Default: 5. */
  readonly minEvalSamples: number;
  /** Stop after N consecutive iterations without improvement. Default: 3. */
  readonly noImprovementLimit: number;
  /** Clock function. Default: Date.now. */
  readonly clock: () => number;
  /** Random function for Thompson sampling. Default: Math.random. */
  readonly random: () => number;
}

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

/** Why the search stopped. */
export type StopReason =
  | "converged" // Reached convergence threshold
  | "budget_exhausted" // Hit maxIterations
  | "thompson_deploy" // Thompson sampling chose to deploy current best
  | "no_improvement" // N consecutive iterations without improvement
  | "eval_failed" // Evaluation callback threw
  | "refine_failed"; // Refinement callback threw

export interface SearchResult {
  /** Best variant found during search. */
  readonly best: SearchNode;
  /** All variants explored (including failures). */
  readonly history: readonly SearchNode[];
  /** Why the search stopped. */
  readonly stopReason: StopReason;
  /** Total iterations completed. */
  readonly totalIterations: number;
  /** Whether the best variant meets the convergence threshold. */
  readonly converged: boolean;
}

// ---------------------------------------------------------------------------
// Persistence interface (future Grove integration — Issue 3B)
// ---------------------------------------------------------------------------

/**
 * Optional persistence for search trees.
 * Allows saving/loading search state across sessions.
 * Not required for the fast inner loop — designed for future Grove integration.
 */
export interface HarnessSearchPersistence {
  readonly saveTree: (targetTool: string, nodes: readonly SearchNode[]) => Promise<void>;
  readonly loadTree: (targetTool: string) => Promise<readonly SearchNode[] | null>;
  readonly publishVariant: (node: SearchNode) => Promise<void>;
}
