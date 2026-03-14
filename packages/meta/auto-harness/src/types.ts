/**
 * Types for @koi/auto-harness — auto-harness composition.
 */

import type {
  BrickArtifact,
  ForgeDemandSignal,
  ForgeStore,
  KoiMiddleware,
  StoreChangeNotifier,
} from "@koi/core";
import type { PolicyCacheHandle } from "@koi/middleware-policy-cache";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AutoHarnessConfig {
  /** Forge store for saving synthesized bricks. */
  readonly forgeStore: ForgeStore;
  /**
   * LLM generation callback: (prompt) → response.
   * Injected by the caller (e.g., from ModelProvider).
   */
  readonly generate: (prompt: string) => Promise<string>;
  /** Maximum synthesis iterations per attempt. Default: 20. */
  readonly maxIterations?: number | undefined;
  /** Maximum synthesis attempts per session. Default: 3. */
  readonly maxSynthesesPerSession?: number | undefined;
  /** Optional notifier for cross-agent cache invalidation. */
  readonly notifier?: StoreChangeNotifier | undefined;
  /** Clock function. Default: Date.now. */
  readonly clock?: (() => number) | undefined;
  /** Random function. Default: Math.random. */
  readonly random?: (() => number) | undefined;
  /** Error handler. Default: console.error. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Recursion gate duration in ms. After this window, the same tool can be
   *  re-synthesized. Default: 1_800_000 (30 minutes). */
  readonly gateDurationMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface AutoHarnessStack {
  /** The policy-cache middleware (INTERCEPT, priority 150). */
  readonly policyCacheMiddleware: KoiMiddleware;
  /** Handle for registering/evicting policies at runtime. */
  readonly policyCacheHandle: PolicyCacheHandle;
  /**
   * synthesizeHarness callback — inject into auto-forge config.
   * When a failure-driven demand signal arrives, this runs the full
   * synthesis + search + verification loop in the background.
   */
  readonly synthesizeHarness: (signal: ForgeDemandSignal) => Promise<BrickArtifact | null>;
  /** Maximum syntheses per session — pass to auto-forge config. */
  readonly maxSynthesesPerSession: number;
  /** Clear the per-session recursion gate. Call between sessions. */
  readonly resetSession: () => void;
}
