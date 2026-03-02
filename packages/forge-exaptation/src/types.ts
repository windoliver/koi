/**
 * Types for @koi/forge-exaptation — exaptation (purpose drift) detection middleware.
 */

import type { ExaptationSignal, KoiMiddleware } from "@koi/core";

// ---------------------------------------------------------------------------
// Thresholds — configurable detection parameters
// ---------------------------------------------------------------------------

/** Configurable thresholds for exaptation detection. */
export interface ExaptationThresholds {
  /** Minimum observations before detection can trigger. Default: 5. */
  readonly minObservations: number;
  /** Jaccard divergence threshold (0-1). Default: 0.7. */
  readonly divergenceThreshold: number;
  /** Minimum distinct agents showing drift. Default: 2. */
  readonly minDivergentAgents: number;
  /** Weight applied to raw confidence score. Default: 0.8. */
  readonly confidenceWeight: number;
}

// ---------------------------------------------------------------------------
// Middleware config — passed to createExaptationDetector
// ---------------------------------------------------------------------------

/** Configuration for the exaptation detector middleware. */
export interface ExaptationConfig {
  /** Minimum time between signals for the same brick (ms). Default: 60_000. */
  readonly cooldownMs: number;
  /** Maximum pending signals before oldest are evicted. Default: 10. */
  readonly maxPendingSignals?: number | undefined;
  /** Maximum observations per brick in ring buffer. Default: 30. */
  readonly maxObservationsPerBrick?: number | undefined;
  /** Maximum words to keep from model response context. Default: 200. */
  readonly maxContextWords?: number | undefined;
  /** Override detection thresholds. */
  readonly thresholds?: Partial<ExaptationThresholds> | undefined;
  /** Called when an exaptation signal is emitted. */
  readonly onSignal?: ((signal: ExaptationSignal) => void) | undefined;
  /** Called when a signal is dismissed. */
  readonly onDismiss?: ((signalId: string) => void) | undefined;
  /** Injectable clock for testing. Default: Date.now. */
  readonly clock?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// Handle — returned by factory, consumed by forge pipeline
// ---------------------------------------------------------------------------

/** Handle returned by the exaptation detector factory. */
export interface ExaptationHandle {
  readonly middleware: KoiMiddleware;
  readonly getSignals: () => readonly ExaptationSignal[];
  readonly dismiss: (signalId: string) => void;
  readonly getActiveSignalCount: () => number;
}
