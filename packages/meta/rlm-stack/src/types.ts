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
 * Default priority for the stack-composed RLM middleware.
 *
 * Set strictly above `@koi/middleware-rlm`'s `DEFAULT_PRIORITY` (`800`) so
 * RLM runs deeper in the intercept tier than other priority-`800` peers
 * (e.g. `@koi/middleware-tool-disclosure`). Equal numeric priorities have
 * undefined relative order in the engine sorter, which would let RLM segment
 * before a peer's `wrapModelCall` materializes its share of the tool list.
 * Adding `+1` enforces a strict ordering without conflicting with any
 * downstream middleware that pins itself at `800`.
 */
export const RLM_STACK_PRIORITY_FLOOR = 801;

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
  /**
   * Optional model id. Forwarded **as-is** (no prefix stripping, no
   * canonicalization) to `@koi/context-manager`'s `resolveThresholds`, so RLM
   * and context-manager always resolve the same window for the same input
   * string. For prefixed or private model ids, supply `modelWindowOverrides`
   * keyed in the same form to control the window in both layers.
   *
   * See the *Caveats* section in `docs/L2/rlm-stack.md` — `resolveThresholds`
   * itself does not currently strip provider prefixes, so a prefixed id will
   * miss the registry and fall back to the registry default in BOTH layers.
   */
  readonly modelId?: string;
  /**
   * Optional per-model context-window overrides forwarded to
   * `resolveThresholds`. Keys must match the form used for `modelId` (bare or
   * prefixed) — `@koi/rlm-stack` does not transform them. Mirrors
   * `@koi/context-manager`'s `modelWindowOverrides` so the two systems
   * resolve the same window for overridden models.
   */
  readonly modelWindowOverrides?: Readonly<Record<string, number>>;
  /** Preset chunk-size profile. Defaults to `"standard"`. */
  readonly tier?: RlmStackTier;
  /**
   * Forwarded to `RlmConfig.priority`. Defaults to `RLM_STACK_PRIORITY_FLOOR`
   * (`801`) — strictly above priority-`800` peers like
   * `@koi/middleware-tool-disclosure` so RLM cannot tie with them in the
   * engine sorter. Values below the floor are rejected at construction time.
   * See the priority row in `docs/L2/rlm-stack.md` for caveats and the
   * `createRlmMiddleware` escape hatch.
   */
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
