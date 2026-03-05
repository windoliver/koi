/**
 * Types for the retry-stack meta-package.
 *
 * Composes semantic-retry, guided-retry, and fs-rollback middleware
 * into a coherent "diagnose → undo → retry smarter" bundle.
 */

import type { KoiMiddleware } from "@koi/core";
import type { FsRollbackConfig, FsRollbackHandle } from "@koi/middleware-fs-rollback";
import type { GuidedRetryConfig, GuidedRetryHandle } from "@koi/middleware-guided-retry";
import type { SemanticRetryConfig, SemanticRetryHandle } from "@koi/middleware-semantic-retry";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Available retry-stack presets. */
export type RetryStackPreset = "light" | "standard" | "aggressive";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the retry-stack bundle. */
export interface RetryStackConfig {
  /** Preset to apply before user overrides. Default: "standard". */
  readonly preset?: RetryStackPreset | undefined;
  /** Semantic-retry middleware config overrides. */
  readonly semanticRetry?: SemanticRetryConfig | undefined;
  /** Guided-retry middleware config overrides. */
  readonly guidedRetry?: GuidedRetryConfig | undefined;
  /**
   * Filesystem rollback config. Requires store, chainId, and backend from the user.
   * Omit to disable fs-rollback entirely.
   */
  readonly fsRollback?: FsRollbackConfig | undefined;
}

// ---------------------------------------------------------------------------
// Preset spec (used internally by presets.ts)
// ---------------------------------------------------------------------------

/** Shape of a preset specification — partial config without fs-rollback (requires I/O backends). */
export interface RetryStackPresetSpec {
  readonly semanticRetry?: Partial<SemanticRetryConfig> | undefined;
  readonly guidedRetry?: Partial<GuidedRetryConfig> | undefined;
  /** When true, preset expects the user to provide fsRollback config. */
  readonly fsRollbackExpected?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Resolved config (internal — after 3-layer merge)
// ---------------------------------------------------------------------------

/** Resolved config after merging defaults → preset → user overrides. */
export interface ResolvedRetryStackConfig {
  readonly preset: RetryStackPreset;
  readonly semanticRetry: SemanticRetryConfig;
  readonly guidedRetry?: GuidedRetryConfig | undefined;
  readonly fsRollback?: FsRollbackConfig | undefined;
}

// ---------------------------------------------------------------------------
// Bundle metadata
// ---------------------------------------------------------------------------

/** Introspection metadata for the resolved retry-stack. */
export interface ResolvedRetryStackMeta {
  readonly preset: RetryStackPreset;
  readonly middlewareCount: number;
  readonly fsRollbackEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Bundle (returned by factory)
// ---------------------------------------------------------------------------

/** Handle returned by createRetryStack(). */
export interface RetryStackBundle {
  /** Middleware array to spread into your agent's middleware chain. */
  readonly middleware: readonly KoiMiddleware[];
  /** Semantic-retry handle for records/budget inspection. */
  readonly semanticRetry: SemanticRetryHandle;
  /** Guided-retry handle for constraint management. */
  readonly guidedRetry: GuidedRetryHandle;
  /** Fs-rollback handle — undefined when fs-rollback is disabled. */
  readonly fsRollback: FsRollbackHandle | undefined;
  /** Introspection metadata. */
  readonly config: ResolvedRetryStackMeta;
  /** Resets semantic-retry records/budget and guided-retry constraints.
   *  Fs-rollback state is not reset — snapshot chains are managed externally. */
  readonly reset: () => void;
}
