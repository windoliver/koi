/**
 * Types for @koi/forge-demand — demand-triggered forge detection middleware.
 *
 * L2 package: depends on @koi/core (L0) + L0u utilities only.
 */

import type { ForgeBudget, ForgeDemandSignal, KoiMiddleware, ToolHealthSnapshot } from "@koi/core";

// ---------------------------------------------------------------------------
// Health handle — read-only interface injected by caller (L2→L2 isolation)
// ---------------------------------------------------------------------------

/**
 * Read-only health interface consumed by the demand detector.
 * The caller (L3 wiring) injects this — `@koi/forge-demand` never imports
 * from `@koi/middleware-feedback-loop` directly. Method name + return shape
 * mirror `ToolHealthTracker` from feedback-loop so the tracker can be passed
 * directly without an adapter.
 */
export interface FeedbackLoopHealthHandle {
  readonly getSnapshot: (toolId: string) => ToolHealthSnapshot | undefined;
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
  readonly latencyDegradationP95Ms: number;
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

/** Handle returned by the demand detector factory. */
export interface ForgeDemandHandle {
  readonly middleware: KoiMiddleware;
  readonly getSignals: () => readonly ForgeDemandSignal[];
  readonly dismiss: (signalId: string) => void;
  readonly getActiveSignalCount: () => number;
}
