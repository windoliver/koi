/**
 * @koi/quality-gate — Output quality assurance meta-package (Layer 3)
 *
 * "Fast gate → Deep validation → Retry with feedback"
 *
 * Composes up to 3 middleware via createQualityGate():
 *   output-verifier (385) → feedback-loop (450) → budget (999)
 */

// ── Types: L2 sub-configs (re-exported for convenience) ─────────────────

export type {
  FeedbackLoopConfig,
  FeedbackLoopHandle,
  ForgeHealthConfig,
  RepairStrategy,
  RetryConfig,
  ValidationError,
  ValidationResult,
  Validator,
} from "@koi/middleware-feedback-loop";

export type {
  DeterministicCheck,
  JudgeConfig,
  VerifierAction,
  VerifierConfig,
  VerifierHandle,
  VerifierStats,
  VerifierVetoEvent,
} from "@koi/middleware-output-verifier";

export {
  BUILTIN_CHECKS,
  matchesPattern,
  maxLength,
  nonEmpty,
  validJson,
} from "@koi/middleware-output-verifier";

// ── Functions ───────────────────────────────────────────────────────────

export { createBudgetMiddleware } from "./budget-middleware.js";
export { resolveQualityGateConfig } from "./config-resolution.js";
export { createQualityGate } from "./quality-gate.js";

// ── Constants ───────────────────────────────────────────────────────────

export { QUALITY_GATE_PRESET_SPECS } from "./presets.js";

// ── Types: quality-gate bundle ──────────────────────────────────────────

export type {
  QualityGateBundle,
  QualityGateConfig,
  QualityGatePreset,
  QualityGatePresetSpec,
  ResolvedQualityGateConfig,
  ResolvedQualityGateMeta,
} from "./types.js";
