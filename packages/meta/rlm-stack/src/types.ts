/**
 * Public types for `@koi/rlm-stack` — config, return shape, and tier constants.
 */

import type { KoiMiddleware, TokenEstimator } from "@koi/core";
import type { SandboxExecutor } from "@koi/core/sandbox-executor";
import type { RlmEvent } from "@koi/middleware-rlm";

/** Preset tiers tuning segmentation aggressiveness. */
export type RlmStackTier = "light" | "standard" | "aggressive";

/** Disposition the stack would apply for a given input size. */
export type RlmDisposition = "passthrough" | "compact" | "virtualize";

/**
 * Default context window assumed when neither `contextWindowTokens` nor a
 * `modelId` lookup yields a window. Mirrors `COMPACTION_DEFAULTS.contextWindowSize`
 * from `@koi/context-manager`.
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Soft compaction trigger fraction. Mirrors `@koi/context-manager`'s default
 * (`COMPACTION_DEFAULTS.micro.triggerFraction`). Held as a constant here so
 * `policyFor` is a pure function with no I/O.
 */
export const SOFT_COMPACT_FRACTION = 0.5;

/** Hard compaction trigger fraction. Mirrors `COMPACTION_DEFAULTS.full.triggerFraction`. */
export const HARD_COMPACT_FRACTION = 0.75;

/** Maximum chars per segment by tier. */
export const CHUNK_CHARS_BY_TIER: Readonly<Record<RlmStackTier, number>> = {
  light: 4_000,
  standard: 8_000,
  aggressive: 16_000,
};

export interface RlmStackConfig {
  /** Total context window of the target model in tokens. */
  readonly contextWindowTokens?: number;
  /** Optional model id (currently informational; reserved for model-registry lookup). */
  readonly modelId?: string;
  /** Preset chunk-size profile. Defaults to `"standard"`. */
  readonly tier?: RlmStackTier;
  /** Forwarded to `RlmConfig.priority`. Default: 800. */
  readonly priority?: number;
  /** Forwarded — required to actually enable virtualization. */
  readonly acknowledgeSegmentLocalContract?: boolean;
  /** Forwarded — internal trusted callers only. */
  readonly trustMetadataRole?: boolean;
  /** Forwarded — separator between reassembled segments. */
  readonly segmentSeparator?: string;
  /** Forwarded — token estimator. */
  readonly estimator?: TokenEstimator;
  /** Forwarded — telemetry callback. */
  readonly onEvent?: (event: RlmEvent) => void;
  /**
   * Reserved for future. The current `@koi/middleware-rlm` does not consume a
   * sandbox executor; it is exposed on the returned stack handle so callers
   * can verify it round-trips and so a future middleware version can pick it
   * up without changing the public API.
   */
  readonly sandboxExecutor?: SandboxExecutor;
}

export interface RlmStackThresholds {
  readonly contextWindowTokens: number;
  readonly maxInputTokens: number;
  readonly maxChunkChars: number;
}

export interface RlmStack {
  readonly middleware: KoiMiddleware;
  readonly thresholds: RlmStackThresholds;
  readonly tier: RlmStackTier;
  readonly sandboxExecutor: SandboxExecutor | undefined;
}
