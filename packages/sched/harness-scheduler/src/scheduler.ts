/**
 * Poll-based harness scheduler — auto-resumes a suspended harness.
 *
 * Polls the harness status at a configurable interval. When the harness
 * is suspended, calls resume(). On failure, applies exponential backoff
 * with jitter. Stops with "failed" phase after maxRetries exhausted.
 */

import type { KoiError } from "@koi/core";
import type { HarnessScheduler, HarnessSchedulerConfig, SchedulerPhase } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Backoff computation (inlined — avoids L2→L1 dep on @koi/engine)
// ---------------------------------------------------------------------------

function computeBackoff(prevUpperMs: number, baseMs: number, capMs: number): number {
  const nextUpper = Math.min(capMs, prevUpperMs * 2);
  return Math.floor(baseMs + Math.random() * (nextUpper - baseMs));
}

// ---------------------------------------------------------------------------
// Terminal harness phases — scheduler stops when harness reaches these
// ---------------------------------------------------------------------------

const TERMINAL_PHASES = new Set(["completed", "failed"]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHarnessScheduler(config: HarnessSchedulerConfig): HarnessScheduler {
  const harness = config.harness;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCapMs = config.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const signal = config.signal;
  const delay =
    config.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let phase: SchedulerPhase = "idle";
  let retriesRemaining = maxRetries;
  let lastError: KoiError | undefined;
  let totalResumes = 0;
  let prevBackoffMs = backoffBaseMs;
  let pollPromise: Promise<void> | undefined;
  let stopRequested = false;

  // -----------------------------------------------------------------------
  // Poll loop
  // -----------------------------------------------------------------------

  async function pollLoop(): Promise<void> {
    while (!stopRequested && phase === "running") {
      await delay(pollIntervalMs);

      // Check abort signal
      if (signal?.aborted === true) {
        phase = "stopped";
        return;
      }

      // Check if stop was requested during delay
      if (stopRequested || phase !== "running") {
        if (phase === "running") phase = "stopped";
        return;
      }

      const harnessPhase = harness.status().phase;

      // Terminal harness state — stop scheduling
      if (TERMINAL_PHASES.has(harnessPhase)) {
        phase = "stopped";
        return;
      }

      // Only resume when suspended
      if (harnessPhase !== "suspended") continue;

      try {
        const result = await harness.resume();
        if (result.ok) {
          totalResumes += 1;
          retriesRemaining = maxRetries;
          lastError = undefined;
          prevBackoffMs = backoffBaseMs;
        } else {
          retriesRemaining -= 1;
          lastError = result.error;
          if (retriesRemaining <= 0) {
            phase = "failed";
            return;
          }
          prevBackoffMs = computeBackoff(prevBackoffMs, backoffBaseMs, backoffCapMs);
          await delay(prevBackoffMs);
        }
      } catch (e: unknown) {
        // resume() threw instead of returning error Result
        retriesRemaining -= 1;
        lastError = {
          code: "INTERNAL",
          message: `resume() threw: ${e instanceof Error ? e.message : String(e)}`,
          retryable: false,
          cause: e instanceof Error ? e : undefined,
        };
        if (retriesRemaining <= 0) {
          phase = "failed";
          return;
        }
        prevBackoffMs = computeBackoff(prevBackoffMs, backoffBaseMs, backoffCapMs);
        await delay(prevBackoffMs);
      }
    }

    // If stop was requested but phase is still "running", transition to "stopped"
    if (phase === "running") {
      phase = "stopped";
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const start = (): void => {
    if (phase !== "idle") return;
    phase = "running";
    pollPromise = pollLoop();
  };

  const stop = (): void => {
    stopRequested = true;
  };

  const status = () => ({
    phase,
    retriesRemaining,
    lastError,
    totalResumes,
  });

  const dispose = async (): Promise<void> => {
    stopRequested = true;
    if (pollPromise !== undefined) {
      await pollPromise;
    }
  };

  return { start, stop, status, dispose };
}
