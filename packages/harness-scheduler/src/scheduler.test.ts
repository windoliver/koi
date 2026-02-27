import { beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { createHarnessScheduler } from "./scheduler.js";
import type { SchedulableHarness } from "./types.js";

// ---------------------------------------------------------------------------
// Mock harness factory
// ---------------------------------------------------------------------------

function createMockHarness(initialPhase: string = "suspended"): SchedulableHarness & {
  readonly setPhase: (p: string) => void;
  readonly setResumeResult: (r: Result<unknown, KoiError>) => void;
  readonly setResumeThrows: (e: Error) => void;
  readonly resumeCallCount: () => number;
} {
  let currentPhase = initialPhase;
  let resumeResult: Result<unknown, KoiError> = { ok: true, value: undefined };
  let resumeThrows: Error | undefined;
  let callCount = 0;

  return {
    status: () => ({ phase: currentPhase }),
    resume: async () => {
      callCount += 1;
      if (resumeThrows !== undefined) throw resumeThrows;
      return resumeResult;
    },
    setPhase: (p: string) => {
      currentPhase = p;
    },
    setResumeResult: (r: Result<unknown, KoiError>) => {
      resumeResult = r;
      resumeThrows = undefined;
    },
    setResumeThrows: (e: Error) => {
      resumeThrows = e;
    },
    resumeCallCount: () => callCount,
  };
}

// ---------------------------------------------------------------------------
// Injectable delay that resolves immediately
// ---------------------------------------------------------------------------

function createImmediateDelay(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}

// ---------------------------------------------------------------------------
// Helper: wait for the poll loop to reach a terminal scheduler phase
// ---------------------------------------------------------------------------

async function waitForPhase(
  scheduler: ReturnType<typeof createHarnessScheduler>,
  targetPhases: readonly string[],
  timeoutMs: number = 2000,
): Promise<void> {
  const start = Date.now();
  while (!targetPhases.includes(scheduler.status().phase)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for phase ${targetPhases.join("|")}, got ${scheduler.status().phase}`,
      );
    }
    await Bun.sleep(1); // yield to event loop so poll loop can progress
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createHarnessScheduler", () => {
  let harness: ReturnType<typeof createMockHarness>;
  const immediateDelay = createImmediateDelay();

  beforeEach(() => {
    harness = createMockHarness("suspended");
  });

  test("resumes harness when suspended (happy path)", async () => {
    // Resume succeeds, then harness completes
    harness.setResumeResult({ ok: true, value: undefined });

    const originalResume = harness.resume.bind(harness);
    const wrappedHarness: SchedulableHarness = {
      status: harness.status,
      resume: async () => {
        const result = await originalResume();
        harness.setPhase("completed"); // complete after first resume
        return result;
      },
    };

    const scheduler = createHarnessScheduler({
      harness: wrappedHarness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["stopped"]);

    expect(harness.resumeCallCount()).toBeGreaterThanOrEqual(1);
    expect(scheduler.status().phase).toBe("stopped");
  });

  test("no-ops when harness is active", async () => {
    harness.setPhase("active");

    let pollCount = 0;
    const countingDelay = async () => {
      pollCount += 1;
      if (pollCount >= 3) {
        harness.setPhase("completed");
      }
    };

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      delay: countingDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["stopped"]);

    expect(harness.resumeCallCount()).toBe(0);
    expect(scheduler.status().phase).toBe("stopped");
  });

  test("stops when harness is completed", async () => {
    harness.setPhase("completed");

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["stopped"]);

    expect(scheduler.status().phase).toBe("stopped");
    expect(harness.resumeCallCount()).toBe(0);
  });

  test("stops when harness is failed", async () => {
    harness.setPhase("failed");

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["stopped"]);

    expect(scheduler.status().phase).toBe("stopped");
    expect(harness.resumeCallCount()).toBe(0);
  });

  test("retries with backoff on resume failure", async () => {
    const error: KoiError = {
      code: "INTERNAL",
      message: "resume failed",
      retryable: true,
    };
    harness.setResumeResult({ ok: false, error });

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      maxRetries: 3,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["failed"]);

    expect(scheduler.status().phase).toBe("failed");
    expect(scheduler.status().retriesRemaining).toBe(0);
    expect(scheduler.status().lastError).toBeDefined();
    expect(scheduler.status().lastError?.message).toBe("resume failed");
  });

  test("stops with failed status after maxRetries exhausted", async () => {
    const error: KoiError = {
      code: "EXTERNAL",
      message: "engine unavailable",
      retryable: true,
    };
    harness.setResumeResult({ ok: false, error });

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      maxRetries: 2,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["failed"]);

    const status = scheduler.status();
    expect(status.phase).toBe("failed");
    expect(status.retriesRemaining).toBe(0);
    expect(status.totalResumes).toBe(0);
  });

  test("stops cleanly on AbortSignal", async () => {
    harness.setPhase("active");
    const controller = new AbortController();

    let pollCount = 0;
    const countingDelay = async () => {
      pollCount += 1;
      if (pollCount >= 2) {
        controller.abort();
      }
    };

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      signal: controller.signal,
      delay: countingDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["stopped"]);

    expect(scheduler.status().phase).toBe("stopped");
  });

  test("handles resume() throwing (not just returning error Result)", async () => {
    harness.setResumeThrows(new Error("unexpected crash"));

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      maxRetries: 1,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["failed"]);

    const status = scheduler.status();
    expect(status.phase).toBe("failed");
    expect(status.lastError).toBeDefined();
    expect(status.lastError?.message).toContain("unexpected crash");
  });

  test("reports accurate status at each phase", async () => {
    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      maxRetries: 5,
      delay: immediateDelay,
    });

    // Before start: idle
    expect(scheduler.status().phase).toBe("idle");
    expect(scheduler.status().retriesRemaining).toBe(5);
    expect(scheduler.status().totalResumes).toBe(0);

    // Complete harness so scheduler stops quickly
    harness.setPhase("completed");
    scheduler.start();
    await waitForPhase(scheduler, ["stopped"]);

    expect(scheduler.status().phase).toBe("stopped");
  });

  test("dispose stops polling", async () => {
    harness.setPhase("active");

    let pollCount = 0;
    const trackingDelay = async () => {
      pollCount += 1;
      // After a few polls, complete the harness to let dispose succeed
      if (pollCount >= 5) {
        harness.setPhase("completed");
      }
    };

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      delay: trackingDelay,
    });

    scheduler.start();
    expect(scheduler.status().phase).toBe("running");

    // stop() sets stopRequested, pollLoop will exit on next iteration
    scheduler.stop();
    await waitForPhase(scheduler, ["stopped"]);
    expect(scheduler.status().phase).toBe("stopped");
  });

  test("start is idempotent when already running", async () => {
    harness.setPhase("completed");

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    scheduler.start();
    scheduler.start(); // second call should be no-op
    await waitForPhase(scheduler, ["stopped"]);

    expect(scheduler.status().phase).toBe("stopped");
  });

  test("dispose awaits poll completion", async () => {
    // When dispose is called on a scheduler that already stopped via terminal harness,
    // it should complete cleanly
    harness.setPhase("completed");

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    scheduler.start();
    // Wait for natural stop
    await waitForPhase(scheduler, ["stopped"]);
    // Dispose after already stopped — should be a no-op
    await scheduler.dispose();
    expect(scheduler.status().phase).toBe("stopped");
  });

  test("throw with retries remaining applies backoff then retries", async () => {
    let callCount = 0;
    const throwingHarness: SchedulableHarness = {
      status: () => ({ phase: "suspended" }),
      resume: async () => {
        callCount += 1;
        if (callCount <= 2) throw new Error("transient throw");
        return { ok: true, value: undefined };
      },
    };

    let backoffDelays = 0;
    const trackingDelay = async () => {
      backoffDelays += 1;
      // After enough calls, set to completed
      if (callCount >= 3) {
        // Mutate status to force stop
        Object.defineProperty(throwingHarness, "status", {
          value: () => ({ phase: "completed" }),
        });
      }
    };

    const scheduler = createHarnessScheduler({
      harness: throwingHarness,
      pollIntervalMs: 10,
      maxRetries: 5,
      delay: trackingDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["stopped", "failed"]);

    // Should have retried after throws, then succeeded
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(backoffDelays).toBeGreaterThanOrEqual(3); // poll + backoff delays
  });

  test("retries reset on successful resume", async () => {
    let callCount = 0;
    const dynamicHarness: SchedulableHarness = {
      status: () => ({ phase: callCount >= 3 ? "completed" : "suspended" }),
      resume: async () => {
        callCount += 1;
        // First call fails, rest succeed
        if (callCount === 1) {
          return {
            ok: false,
            error: {
              code: "INTERNAL" as const,
              message: "transient failure",
              retryable: true,
            },
          };
        }
        return { ok: true, value: undefined };
      },
    };

    const scheduler = createHarnessScheduler({
      harness: dynamicHarness,
      pollIntervalMs: 10,
      maxRetries: 3,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["stopped", "failed"]);

    const status = scheduler.status();
    expect(status.phase).toBe("stopped");
    // Retries should have been reset after the successful resume
    expect(status.retriesRemaining).toBe(3);
    expect(status.totalResumes).toBeGreaterThanOrEqual(1);
  });
});
