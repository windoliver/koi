/**
 * @koi/harness-synth — single-candidate forge synthesis with verifier-driven retry (L2).
 *
 * Loop: prompt → generate (LLM) → parse → verify → on-fail refine → retry.
 * Multi-candidate fitness search lives in `@koi/harness-search`.
 */

export { type ParsedOutput, type ParseResult, parseSynthesisOutput } from "./parser.js";
export { buildRefinementPrompt, type RefinementPromptContext } from "./prompts/refinement.js";
export { buildSynthesisPrompt, type SynthesisPromptContext } from "./prompts/synthesis.js";
export { type SynthesisInitConfig, synthesize } from "./synthesize.js";
export {
  DEFAULT_SYNTHESIS_CONFIG,
  FORGED_BY,
  type GenerateCallback,
  type SynthesisConfig,
  type SynthesisInput,
  type SynthesisOutput,
  type SynthesisResult,
  type VerifyCallback,
  type VerifyResult,
} from "./types.js";
