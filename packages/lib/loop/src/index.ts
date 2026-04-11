/**
 * @koi/loop — convergence loop primitive.
 *
 * L2 package. Public entry point re-exports the public API and nothing else.
 * Internal helpers (state-machine, budget, rebuild-prompt, gates/*) are
 * imported from source paths by the tests; consumers go through this file.
 */

// ── Gates ────────────────────────────────────────────────────────────────
export { type ArgvGateOptions, createArgvGate } from "./gates/argv-gate.js";
export { createCompositeGate } from "./gates/composite-gate.js";
export { createFileGate } from "./gates/file-gate.js";
// ── Prompt helpers (exported for callers building custom rebuilders) ─────
export {
  defaultRebuildPrompt,
  normalizeDetails,
  normalizeVerifierResult,
  redactCredentials,
  sanitizeDetails,
  truncateBytes,
} from "./rebuild-prompt.js";
// ── Main loop ─────────────────────────────────────────────────────────────
export { runUntilPass } from "./run-until-pass.js";
// ── Types ────────────────────────────────────────────────────────────────
export type {
  IterationRecord,
  LoopEvent,
  LoopRuntime,
  LoopStatus,
  RebuildPromptContext,
  RunUntilPassConfig,
  RunUntilPassResult,
  TokenBudget,
  Verifier,
  VerifierContext,
  VerifierFailureReason,
  VerifierResult,
} from "./types.js";
export { LOOP_DEFAULTS } from "./types.js";
