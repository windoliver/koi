import { beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { createHarnessScheduler } from "./scheduler.js";
import type { SchedulableHarness } from "./types.js";

function createMockHarness(initialPhase: string = "suspended"): SchedulableHarness & {
  readonly setPhase: (phase: string) => void;
  readonly setResumeResult: (result: Result<unknown, KoiError>) => void;
  readonly setResumeThrows: (error: Error) => void;
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
    setPhase: (phase: string) => {
      currentPhase = phase;
    },
    setResumeResult: (result: Result<unknown, KoiError>) => {
      resumeResult = result;
      resumeThrows = undefined;
    },
    setResumeThrows: (error: Error) => {
      resumeThrows = error;
    },
    resumeCallCount: () => callCount,
  };
}

function createImmediateDelay(): (ms: number) => Promise<void> {
  return async () => {};
}

async function waitForPhase(
  scheduler: ReturnType<typeof createHarnessScheduler>,
  targetPhases: readonly string[],
  timeoutMs: number = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!targetPhases.includes(scheduler.status().phase)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for phase ${targetPhases.join("|")}, got ${scheduler.status().phase}`,
      );
    }
    await Bun.sleep(1);
  }
}

describe("createHarnessScheduler", () => {
  let harness: ReturnType<typeof createMockHarness>;
  const immediateDelay = createImmediateDelay();

  beforeEach(() => {
    harness = createMockHarness("suspended");
  });

  test("resumes harness when suspended", async () => {
    const originalResume = harness.resume.bind(harness);
    const wrappedHarness: SchedulableHarness = {
      status: harness.status,
      resume: async () => {
        const result = await originalResume();
        harness.setPhase("completed");
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

    expect(harness.resumeCallCount()).toBe(1);
    expect(scheduler.status().phase).toBe("stopped");
    expect(scheduler.status().totalResumes).toBe(1);
  });

  test("does not resume when harness is active", async () => {
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
  });

  test("stops when harness reaches a terminal phase", async () => {
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

  test("fails after retry budget is exhausted", async () => {
    const error: KoiError = {
      code: "INTERNAL",
      message: "resume failed",
      retryable: true,
    };
    harness.setResumeResult({ ok: false, error });

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      maxRetries: 2,
      backoffBaseMs: 1,
      backoffCapMs: 1,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["failed"]);

    expect(harness.resumeCallCount()).toBe(2);
    expect(scheduler.status().phase).toBe("failed");
    expect(scheduler.status().retriesRemaining).toBe(0);
    expect(scheduler.status().lastError?.message).toBe("resume failed");
  });

  test("records thrown resume errors as failed status", async () => {
    harness.setResumeThrows(new Error("unexpected crash"));

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      maxRetries: 1,
      delay: immediateDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["failed"]);

    expect(scheduler.status().phase).toBe("failed");
    expect(scheduler.status().lastError?.message).toContain("unexpected crash");
  });

  test("stops cleanly on abort", async () => {
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

  test("stop transitions the scheduler out of running", async () => {
    harness.setPhase("active");

    let pollCount = 0;
    const trackingDelay = async () => {
      pollCount += 1;
      if (pollCount >= 2) {
        scheduler.stop();
      }
    };

    const scheduler = createHarnessScheduler({
      harness,
      pollIntervalMs: 10,
      delay: trackingDelay,
    });

    scheduler.start();
    await waitForPhase(scheduler, ["stopped"]);

    expect(scheduler.status().phase).toBe("stopped");
    expect(harness.resumeCallCount()).toBe(0);
  });
});
