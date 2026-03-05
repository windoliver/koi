/**
 * @koi/retry-stack — Intelligent retry and recovery meta-package (Layer 3)
 *
 * "Diagnose → Undo → Retry smarter"
 *
 * Composes up to 3 middleware via createRetryStack():
 *   fs-rollback (350) → semantic-retry (420) → guided-retry (425)
 */

// ── Types: L2 sub-configs (re-exported for convenience) ─────────────────

export type {
  FsRollbackConfig,
  FsRollbackHandle,
} from "@koi/middleware-fs-rollback";

export type {
  GuidedRetryConfig,
  GuidedRetryHandle,
} from "@koi/middleware-guided-retry";

export type {
  FailureAnalyzer,
  FailureClass,
  FailureClassKind,
  OnRetryCallback,
  PromptRewriter,
  RetryAction,
  RetryActionKind,
  RetryRecord,
  SemanticRetryConfig,
  SemanticRetryHandle,
} from "@koi/middleware-semantic-retry";

// ── Functions ───────────────────────────────────────────────────────────

export { resolveRetryStackConfig } from "./config-resolution.js";
export { createRetryStack } from "./retry-stack.js";

// ── Constants ───────────────────────────────────────────────────────────

export { RETRY_STACK_PRESET_SPECS } from "./presets.js";

// ── Types: retry-stack bundle ───────────────────────────────────────────

export type {
  ResolvedRetryStackConfig,
  ResolvedRetryStackMeta,
  RetryStackBundle,
  RetryStackConfig,
  RetryStackPreset,
  RetryStackPresetSpec,
} from "./types.js";
