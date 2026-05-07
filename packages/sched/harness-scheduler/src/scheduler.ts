import type { KoiError } from "@koi/core";
import type { HarnessScheduler, HarnessSchedulerConfig, SchedulerPhase } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const TERMINAL_PHASES = new Set(["completed", "failed"]);

function computeBackoff(previousUpperMs: number, baseMs: number, capMs: number): number {
  const nextUpperMs = Math.min(capMs, previousUpperMs * 2);
  return Math.floor(baseMs + Math.random() * (nextUpperMs - baseMs));
}

function toInternalError(error: unknown): KoiError {
  return {
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    cause: error instanceof Error ? error : undefined,
  };
}

export function createHarnessScheduler(config: HarnessSchedulerConfig): HarnessScheduler {
  const {
    harness,
    signal,
    onResumed,
    delay = async (ms: number) => {
      await Bun.sleep(ms);
    },
  } = config;

  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCapMs = config.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

  let phase: SchedulerPhase = "idle";
  let retriesRemaining = maxRetries;
  let totalResumes = 0;
  let lastError: KoiError | undefined;
  let previousBackoffMs = backoffBaseMs;
  let stopRequested = false;
  let pollPromise: Promise<void> | undefined;

  async function pollLoop(): Promise<void> {
    while (!stopRequested && phase === "running") {
      await delay(pollIntervalMs);

      if (signal?.aborted === true || stopRequested) {
        phase = "stopped";
        return;
      }

      const harnessPhase = harness.status().phase;
      if (TERMINAL_PHASES.has(harnessPhase)) {
        phase = "stopped";
        return;
      }

      if (harnessPhase !== "suspended") {
        continue;
      }

      try {
        const result = await harness.resume();
        if (!result.ok) {
          retriesRemaining -= 1;
          lastError = result.error;
          if (retriesRemaining <= 0) {
            phase = "failed";
            return;
          }

          previousBackoffMs = computeBackoff(previousBackoffMs, backoffBaseMs, backoffCapMs);
          await delay(previousBackoffMs);
          continue;
        }

        totalResumes += 1;
        retriesRemaining = maxRetries;
        lastError = undefined;
        previousBackoffMs = backoffBaseMs;

        if (onResumed !== undefined) {
          try {
            await onResumed(result.value);
          } catch (error: unknown) {
            retriesRemaining -= 1;
            lastError = {
              code: "INTERNAL",
              message: `onResumed failed: ${error instanceof Error ? error.message : String(error)}`,
              retryable: true,
              cause: error instanceof Error ? error : undefined,
            };
            if (retriesRemaining <= 0) {
              phase = "failed";
              return;
            }

            previousBackoffMs = computeBackoff(previousBackoffMs, backoffBaseMs, backoffCapMs);
            await delay(previousBackoffMs);
          }
        }
      } catch (error: unknown) {
        retriesRemaining -= 1;
        lastError = toInternalError(error);
        if (retriesRemaining <= 0) {
          phase = "failed";
          return;
        }

        previousBackoffMs = computeBackoff(previousBackoffMs, backoffBaseMs, backoffCapMs);
        await delay(previousBackoffMs);
      }
    }

    if (phase === "running") {
      phase = "stopped";
    }
  }

  return {
    start: (): void => {
      if (phase !== "idle") {
        return;
      }

      phase = "running";
      pollPromise = pollLoop();
    },
    stop: (): void => {
      stopRequested = true;
    },
    status: () => ({
      phase,
      retriesRemaining,
      lastError,
      totalResumes,
    }),
    dispose: async (): Promise<void> => {
      stopRequested = true;
      await pollPromise;
    },
  };
}
