/**
 * @koi/middleware-output-verifier — Two-stage output quality gate (L2).
 *
 * Stage 1: deterministic checks (fast, always runs).
 * Stage 2: optional LLM-as-judge (semantic scoring, sampled, may revise).
 *
 * Actions: block (throw), warn (deliver + event), revise (inject feedback + retry).
 * Streaming: block/revise degrade to warn (content already yielded).
 *
 * Priority 385: between guardrails (375) and memory (400).
 */

export {
  BUILTIN_CHECKS,
  matchesPattern,
  maxLength,
  nonEmpty,
  validJson,
} from "./builtin-checks.js";
export { buildJudgePrompt, parseJudgeResponse } from "./judge.js";
export { createOutputVerifierMiddleware } from "./output-verifier.js";
export type {
  DeterministicCheck,
  JudgeConfig,
  JudgeResult,
  VerifierAction,
  VerifierConfig,
  VerifierHandle,
  VerifierStats,
  VerifierVetoEvent,
} from "./types.js";
