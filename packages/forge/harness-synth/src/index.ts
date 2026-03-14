/**
 * @koi/harness-synth — Synthesize middleware code from observed agent failures.
 *
 * L2 package. Consumes @koi/failure-context data, generates wrapToolCall
 * middleware via LLM, and outputs structured code ready for forge-verifier.
 *
 * The LLM callback is injected via config (no direct model dependency).
 */

export {
  aggregateFailures,
  clusterByErrorPattern,
  deduplicateFailures,
  filterRecursive,
  filterStale,
} from "./aggregator.js";
export { type ParsedOutput, type ParseResult, parseSynthesisOutput } from "./parser.js";
export { buildRefinementPrompt, type RefinementPromptContext } from "./prompts/refinement.js";
export { buildSynthesisPrompt, type SynthesisPromptContext } from "./prompts/synthesis.js";
export { synthesize } from "./synthesize.js";
export {
  type AggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG,
  DEFAULT_SYNTHESIS_CONFIG,
  type GenerateCallback,
  type QualifiedFailures,
  type SynthesisConfig,
  type SynthesisInput,
  type SynthesisOutput,
  type SynthesisResult,
  type ToolFailureRecord,
} from "./types.js";
