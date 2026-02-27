/**
 * Types for @koi/autonomous — coordinated autonomous agent composition.
 */

import type { KoiMiddleware } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";

// ---------------------------------------------------------------------------
// Factory input — accept pre-constructed parts (instance-based)
// ---------------------------------------------------------------------------

export interface AutonomousAgentParts {
  /** The long-running harness managing multi-session lifecycle. */
  readonly harness: LongRunningHarness;
  /** The scheduler that auto-resumes the harness when suspended. */
  readonly scheduler: HarnessScheduler;
  /** Optional compactor middleware for context compaction. */
  readonly compactorMiddleware?: KoiMiddleware | undefined;
}

// ---------------------------------------------------------------------------
// Autonomous agent — composed output
// ---------------------------------------------------------------------------

export interface AutonomousAgent {
  /** The underlying harness. */
  readonly harness: LongRunningHarness;
  /** The scheduler managing auto-resume. */
  readonly scheduler: HarnessScheduler;
  /** Collect all middleware (harness + optional compactor). */
  readonly middleware: () => readonly KoiMiddleware[];
  /** Dispose all parts in correct order (scheduler first, then harness). */
  readonly dispose: () => Promise<void>;
}
