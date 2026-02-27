/**
 * @koi/middleware-output-verifier — Two-stage output quality gate (Layer 2)
 *
 * Runs deterministic checks and an optional LLM-as-judge before delivering
 * any model output. Tracks veto rate (targeting 25% baseline per Spotify pattern).
 *
 * Stage 1 (deterministic): Fast content checks — always runs.
 * Stage 2 (LLM-as-judge): Semantic quality scoring — skipped if Stage 1 blocks.
 *
 * Actions: block (throw), warn (deliver + event), revise (inject feedback + retry).
 * For streaming: revise/block degrade to warn (content already yielded).
 *
 * Priority 385: between guardrails (375) and memory (400).
 *
 * Depends on @koi/core and @koi/errors only.
 */

export {
  BUILTIN_CHECKS,
  matchesPattern,
  maxLength,
  nonEmpty,
  validJson,
} from "./builtin-checks.js";
export type { JudgeResult } from "./judge.js";
export { buildJudgePrompt, clampScore, parseJudgeResponse } from "./judge.js";
export { createOutputVerifierMiddleware } from "./output-verifier.js";
export type {
  DeterministicCheck,
  JudgeConfig,
  VerifierAction,
  VerifierConfig,
  VerifierHandle,
  VerifierStats,
  VerifierVetoEvent,
} from "./types.js";
