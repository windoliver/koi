/**
 * Types for @koi/harness-scheduler — auto-resume scheduler for long-running harness.
 *
 * Uses a minimal structural interface (SchedulableHarness) to avoid
 * L2→L2 dependency on @koi/long-running.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Minimal harness interface (structural, avoids L2→L2 dep)
// ---------------------------------------------------------------------------

/**
 * Minimal interface the scheduler needs from a harness.
 * Structurally compatible with LongRunningHarness from @koi/long-running.
 */
export interface SchedulableHarness {
  readonly status: () => { readonly phase: string };
  readonly resume: () => Promise<Result<unknown, KoiError>>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HarnessSchedulerConfig {
  /** The harness to poll and auto-resume. */
  readonly harness: SchedulableHarness;
  /** Polling interval in milliseconds. Default: 5000. */
  readonly pollIntervalMs?: number | undefined;
  /** Base backoff delay in ms after a failed resume. Default: 1000. */
  readonly backoffBaseMs?: number | undefined;
  /** Maximum backoff cap in ms. Default: 60_000. */
  readonly backoffCapMs?: number | undefined;
  /** Maximum consecutive resume failures before stopping. Default: 3. */
  readonly maxRetries?: number | undefined;
  /** AbortSignal for external cancellation. */
  readonly signal?: AbortSignal | undefined;
  /** Injectable delay function for tests. Default: Bun.sleep. */
  readonly delay?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called after a successful resume(). Responsible for running the engine
   * sub-session and pausing the harness when done. The scheduler awaits this
   * callback before continuing the poll loop.
   *
   * When absent, the scheduler only calls resume() (legacy behavior —
   * caller is responsible for driving sessions externally).
   */
  readonly onResumed?: ((resumeResult: unknown) => Promise<void>) | undefined;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type SchedulerPhase = "idle" | "running" | "stopped" | "failed";

export interface HarnessSchedulerStatus {
  readonly phase: SchedulerPhase;
  readonly retriesRemaining: number;
  readonly lastError?: KoiError | undefined;
  readonly totalResumes: number;
}

// ---------------------------------------------------------------------------
// Scheduler interface
// ---------------------------------------------------------------------------

export interface HarnessScheduler {
  /** Begin polling the harness. */
  readonly start: () => void;
  /** Gracefully stop polling. */
  readonly stop: () => void;
  /** Current scheduler status. */
  readonly status: () => HarnessSchedulerStatus;
  /** Stop polling and release resources. */
  readonly dispose: () => Promise<void>;
}
