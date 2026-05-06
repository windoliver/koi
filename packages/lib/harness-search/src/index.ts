/**
 * @koi/harness-search — bounded refinement loop over forge variants (L2).
 *
 * Pairs with @koi/harness-synth (#1353): synth produces a single verified
 * candidate; harness-search drives iterative refinement of that candidate
 * with caller-injected refine + evaluate callbacks. Always terminates.
 */

export { linearSearch, shouldContinue } from "./linear-search.js";
export { parseRefinementOutput } from "./parse-refinement.js";
export {
  DEFAULT_SEARCH_CONFIG,
  type EvalFailure,
  type EvalResult,
  type EvaluateCallback,
  type RefineCallback,
  type SanitizeFailures,
  type SearchConfig,
  type SearchNode,
  type SearchResult,
  type StopReason,
} from "./types.js";
