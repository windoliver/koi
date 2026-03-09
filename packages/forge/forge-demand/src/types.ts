/**
 * Types for @koi/forge-demand — demand-triggered forge detection middleware.
 */

import type { ForgeBudget, ForgeDemandSignal, KoiMiddleware, ToolHealthSnapshot } from "@koi/core";

// ---------------------------------------------------------------------------
// Recovery context — enriches demand signals with trajectory analysis (Phase 3A)
// ---------------------------------------------------------------------------

/**
 * Recovery context from ACE trajectory analysis.
 * Injected by L3 wiring — the demand detector never imports from @koi/middleware-ace.
 */
export interface RecoveryContext {
  /** Whether the agent eventually recovered from the failure. */
  readonly succeeded: boolean;
  /** Tool IDs used during recovery. */
  readonly recoveryTools: readonly string[];
  /** Whether the recovery involved terminal/shell commands. */
  readonly usedTerminal: boolean;
  /** Number of steps in the recovery sequence. */
  readonly stepCount: number;
}

/**
 * Optional recovery analyzer — queries ACE trajectory for recovery patterns.
 * Injected by L3 (not imported from L2) to avoid L2→L2 dependency.
 */
export interface RecoveryAnalyzer {
  /** Analyze recent trajectory for recovery patterns after a tool failure. */
  readonly analyzeRecovery: (toolId: string) => RecoveryContext | undefined;
}

// ---------------------------------------------------------------------------
// Health handle — L0-compatible read-only interface injected by caller
// ---------------------------------------------------------------------------

/**
 * Read-only health interface for the demand detector.
 * Injected by caller, not imported from @koi/middleware-feedback-loop.
 */
export interface FeedbackLoopHealthHandle {
  readonly getHealthSnapshot: (toolId: string) => ToolHealthSnapshot | undefined;
  readonly isQuarantined: (toolId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Heuristic thresholds — configurable detection parameters
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
  /** P95 latency threshold for degradation detection (ms). Default: 5000. */
  readonly latencyDegradationP95Ms: number;
  /** Minimum tool calls to consider a task "complex". Default: 5. */
  readonly complexTaskToolCallThreshold: number;
  /** Minimum tool sequence length for novel workflow detection. Default: 3. */
  readonly novelWorkflowMinLength: number;
  /** Confidence weight distribution. */
  readonly confidenceWeights: ConfidenceWeights;
}

// ---------------------------------------------------------------------------
// Middleware config — passed to createForgeDemandDetector
// ---------------------------------------------------------------------------

/** Configuration for the forge demand detector middleware. */
export interface ForgeDemandConfig {
  /** Budget constraints for demand-triggered forging. */
  readonly budget: ForgeBudget;
  /** Optional health tracker handle — enables failure/degradation detection. */
  readonly healthTracker?: FeedbackLoopHealthHandle | undefined;
  /** Optional recovery analyzer — enriches demand signals with trajectory data (Phase 3A). */
  readonly recoveryAnalyzer?: RecoveryAnalyzer | undefined;
  /** Regex patterns for capability gap detection in model responses. */
  readonly capabilityGapPatterns?: readonly RegExp[] | undefined;
  /** Regex patterns for user correction detection. Defaults to built-in patterns. */
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
// Handle — returned by factory, consumed by forge pipeline
// ---------------------------------------------------------------------------

/** Handle returned by the demand detector factory. */
export interface ForgeDemandHandle {
  readonly middleware: KoiMiddleware;
  readonly getSignals: () => readonly ForgeDemandSignal[];
  readonly dismiss: (signalId: string) => void;
  readonly getActiveSignalCount: () => number;
}
