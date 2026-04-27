/**
 * Types for @koi/forge-demand — demand-triggered forge detection middleware.
 *
 * L2 package: depends on @koi/core (L0) + L0u utilities only.
 */

import type {
  ForgeBudget,
  ForgeDemandSignal,
  KoiMiddleware,
  SessionContext,
  SessionId,
  ToolHealthSnapshot,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Health handle — read-only interface injected by caller (L2→L2 isolation)
// ---------------------------------------------------------------------------

/**
 * Read-only health interface consumed by the demand detector.
 *
 * Takes a `sessionId` so session-bound implementations (the typical case
 * — feedback-loop keeps trackers per session) can return the right
 * snapshot. Static "global tracker" implementations are still legal:
 * they may ignore the sessionId. The caller (L3 wiring) injects this;
 * `@koi/forge-demand` never imports from `@koi/middleware-feedback-loop`
 * directly.
 */
export interface FeedbackLoopHealthHandle {
  readonly getSnapshot: (sessionId: SessionId, toolId: string) => ToolHealthSnapshot | undefined;
}

// ---------------------------------------------------------------------------
// Heuristic thresholds
// ---------------------------------------------------------------------------

/** Confidence weight distribution across trigger kinds. */
export interface ConfidenceWeights {
  readonly repeatedFailure: number;
  readonly capabilityGap: number;
  readonly performanceDegradation: number;
}

/** Configurable thresholds for heuristic detection. */
export interface HeuristicThresholds {
  /** Consecutive failures before triggering demand. Default: 3. */
  readonly repeatedFailureCount: number;
  /** Capability gap occurrences before triggering. Default: 2. */
  readonly capabilityGapOccurrences: number;
  /** Average latency threshold for degradation detection (ms). Default: 5000. */
  readonly latencyDegradationAvgMs: number;
  /** Confidence weight distribution. */
  readonly confidenceWeights: ConfidenceWeights;
}

// ---------------------------------------------------------------------------
// Middleware config
// ---------------------------------------------------------------------------

/** Configuration for the forge demand detector middleware. */
export interface ForgeDemandConfig {
  /** Budget constraints for demand-triggered forging. */
  readonly budget: ForgeBudget;
  /** Optional health tracker handle — enables latency degradation detection. */
  readonly healthTracker?: FeedbackLoopHealthHandle | undefined;
  /** Regex patterns for capability gap detection in model responses. */
  readonly capabilityGapPatterns?: readonly RegExp[] | undefined;
  /** Regex patterns for user correction detection. */
  readonly userCorrectionPatterns?: readonly RegExp[] | undefined;
  /** Override heuristic thresholds. */
  readonly heuristics?: Partial<HeuristicThresholds> | undefined;
  /** Called when a demand signal is emitted. */
  readonly onDemand?: ((signal: ForgeDemandSignal) => void) | undefined;
  /** Called when a signal is dismissed. */
  readonly onDismiss?: ((signalId: string) => void) | undefined;
  /** Injectable clock for testing. Default: Date.now. */
  readonly clock?: (() => number) | undefined;
  /** Maximum pending signals before oldest are evicted. Default: 10. */
  readonly maxPendingSignals?: number | undefined;
}

// ---------------------------------------------------------------------------
// Handle returned by factory
// ---------------------------------------------------------------------------

/**
 * Session-scoped view of one detector's state. Returned by
 * `ForgeDemandHandle.forSession(ctx)` — the only way to inspect or
 * dismiss signals. There is intentionally no cross-session aggregator
 * exposed: signals carry tenant-private context (failure messages,
 * correction text) and the detector must not let one caller read or
 * acknowledge another tenant's demand state.
 */
export interface SessionScopedForgeDemandHandle {
  readonly getSignals: () => readonly ForgeDemandSignal[];
  readonly dismiss: (signalId: string) => void;
  readonly getActiveSignalCount: () => number;
}

/**
 * Handle returned by the demand detector factory.
 *
 * `forSession(ctx)` produces a session-scoped handle. Callers are
 * expected to pass the `SessionContext` they received from the agent
 * loop (`ctx.session`). The bare cross-session `getSignals(sessionId)`
 * surface is intentionally NOT exposed — it would let any in-process
 * caller with knowledge of a sessionId read or dismiss tenant-private
 * signals, and there is no capability check at this layer.
 */
export interface ForgeDemandHandle {
  readonly middleware: KoiMiddleware;
  readonly forSession: (session: SessionContext) => SessionScopedForgeDemandHandle;
}
