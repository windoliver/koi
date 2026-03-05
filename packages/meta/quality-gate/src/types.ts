/**
 * Types for the quality-gate meta-package.
 *
 * Composes output-verifier and feedback-loop middleware into a
 * "fast gate → deep validation → retry with feedback" bundle.
 * Adds a budget middleware to cap total model calls when both retry.
 */

import type { KoiMiddleware } from "@koi/core";
import type { FeedbackLoopConfig, FeedbackLoopHandle } from "@koi/middleware-feedback-loop";
import type { VerifierConfig, VerifierHandle } from "@koi/middleware-output-verifier";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Available quality-gate presets. */
export type QualityGatePreset = "light" | "standard" | "aggressive";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the quality-gate bundle. */
export interface QualityGateConfig {
  /** Preset to apply before user overrides. Default: "standard". */
  readonly preset?: QualityGatePreset | undefined;
  /** Output-verifier middleware config overrides. Omit to disable. */
  readonly verifier?: VerifierConfig | undefined;
  /** Feedback-loop middleware config overrides. Omit to disable. */
  readonly feedbackLoop?: FeedbackLoopConfig | undefined;
  /**
   * Maximum total model calls per wrapModelCall invocation.
   * Caps retries across both verifier and feedback-loop.
   * Set to undefined to disable budget enforcement. Default: 6.
   */
  readonly maxTotalModelCalls?: number | undefined;
}

// ---------------------------------------------------------------------------
// Preset spec (used internally by presets.ts)
// ---------------------------------------------------------------------------

/** Shape of a preset specification. Both VerifierConfig and FeedbackLoopConfig
 *  have all-optional fields, so no Partial<> wrapper is needed. */
export interface QualityGatePresetSpec {
  readonly verifier?: VerifierConfig | undefined;
  readonly feedbackLoop?: FeedbackLoopConfig | undefined;
  readonly maxTotalModelCalls?: number | undefined;
}

// ---------------------------------------------------------------------------
// Resolved config (internal — after 3-layer merge)
// ---------------------------------------------------------------------------

/** Resolved config after merging defaults → preset → user overrides. */
export interface ResolvedQualityGateConfig {
  readonly preset: QualityGatePreset;
  readonly verifier?: VerifierConfig | undefined;
  readonly feedbackLoop?: FeedbackLoopConfig | undefined;
  readonly maxTotalModelCalls?: number | undefined;
}

// ---------------------------------------------------------------------------
// Bundle metadata
// ---------------------------------------------------------------------------

/** Introspection metadata for the resolved quality-gate. */
export interface ResolvedQualityGateMeta {
  readonly preset: QualityGatePreset;
  readonly middlewareCount: number;
  readonly verifierEnabled: boolean;
  readonly feedbackLoopEnabled: boolean;
  readonly budgetEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Bundle (returned by factory)
// ---------------------------------------------------------------------------

/** Handle returned by createQualityGate(). */
export interface QualityGateBundle {
  /** Middleware array to spread into your agent's middleware chain. */
  readonly middleware: readonly KoiMiddleware[];
  /** Output-verifier handle — undefined when verifier is disabled. */
  readonly verifier: VerifierHandle | undefined;
  /** Feedback-loop handle — undefined when feedback-loop is disabled. */
  readonly feedbackLoop: FeedbackLoopHandle | undefined;
  /** Introspection metadata. */
  readonly config: ResolvedQualityGateMeta;
  /** Resets verifier stats. Feedback-loop health persists per session.
   *  Budget counter auto-resets on turn boundaries and is unaffected by reset(). */
  readonly reset: () => void;
}
