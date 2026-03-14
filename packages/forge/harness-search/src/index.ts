/**
 * @koi/harness-search — Iterative refinement search over middleware variants.
 *
 * L2 package. Uses Thompson sampling for the continue/deploy decision.
 * v1: Linear refinement (single best variant, iterative improvement).
 * v2 (future): Tree search with branching.
 *
 * Callbacks (refine, evaluate) are injected via config by L3 wiring.
 */

export { linearSearch, shouldContinue } from "./linear-search.js";
export { parseRefinementOutput } from "./parse-refinement.js";
export {
  DEFAULT_SEARCH_CONFIG,
  type EvalFailure,
  type EvalResult,
  type EvaluateCallback,
  type HarnessSearchPersistence,
  type RefineCallback,
  type SearchConfig,
  type SearchNode,
  type SearchResult,
  type StopReason,
} from "./types.js";
