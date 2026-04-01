/**
 * @koi/harness-scheduler — auto-resume scheduler for long-running harness (L2).
 *
 * Polls harness status and auto-resumes when suspended.
 * Poll-based with configurable backoff. Stops after maxRetries exhausted.
 */
export { createHarnessScheduler } from "./scheduler.js";
export type {
  HarnessScheduler,
  HarnessSchedulerConfig,
  HarnessSchedulerStatus,
  SchedulableHarness,
  SchedulerPhase,
} from "./types.js";
