/**
 * Retry signal protocol — L0 types for cross-middleware retry coordination.
 *
 * Defines the signal contract between retry-producing middleware (e.g.,
 * semantic-retry) and retry-consuming observers (e.g., event-trace).
 *
 * Because retry producers and consumers are peer L2 packages that cannot
 * import each other, this protocol lives in L0. The L3 runtime compose
 * layer creates a broker instance and injects it into both sides.
 */

// ---------------------------------------------------------------------------
// Retry signal — written by retry middleware, read by event-trace
// ---------------------------------------------------------------------------

/**
 * Signal describing an in-flight retry attempt.
 *
 * Written by retry middleware after classifying a failure and deciding to retry.
 * Read by event-trace to annotate trajectory steps with retry metadata.
 */
export interface RetrySignal {
  /** Whether a retry is currently in progress. */
  readonly retrying: boolean;
  /**
   * Turn index where the original failure occurred.
   * Note: this is the turn index, not the trajectory step index, because
   * the retry middleware (L2) does not have access to event-trace's step counter.
   * Event-trace records this as `metadata.retryOfTurn` for correlation.
   */
  readonly originTurnIndex: number;
  /** Human-readable reason for the retry (from failure analysis). */
  readonly reason: string;
  /** Failure class that triggered the retry (e.g., "tool_misuse", "api_error"). */
  readonly failureClass: string;
  /** 1-based attempt number (1 = first retry, 2 = second retry, etc.). */
  readonly attemptNumber: number;
}

// ---------------------------------------------------------------------------
// Signal broker — write side + read side
// ---------------------------------------------------------------------------

/** Write side: used by retry middleware to publish retry signals. */
export interface RetrySignalWriter {
  /** Set the active retry signal for a session. */
  readonly setRetrySignal: (sessionId: string, signal: RetrySignal) => void;
  /** Clear the retry signal after successful retry or abort. */
  readonly clearRetrySignal: (sessionId: string) => void;
}

/** Read side: used by event-trace to consume retry signals. */
export interface RetrySignalReader {
  /** Get the active retry signal for a session, or undefined if none. */
  readonly getRetrySignal: (sessionId: string) => RetrySignal | undefined;
}

/** Combined broker interface — injected by the L3 runtime compose layer. */
export type RetrySignalBroker = RetrySignalWriter & RetrySignalReader;
