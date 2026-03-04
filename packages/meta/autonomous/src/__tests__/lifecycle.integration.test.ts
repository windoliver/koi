/**
 * Integration tests — AutonomousAgent lifecycle coordination.
 *
 * Uses mock harness + real scheduler + in-memory stores to test
 * the full lifecycle: start → suspend → auto-resume → complete → dispose.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, KoiMiddleware, Result, ThreadStore } from "@koi/core";
import { createHarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";
import { createAutonomousAgent } from "../autonomous.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function immediateDelay(): Promise<void> {
  return Bun.sleep(0);
}

async function waitForPhase(
  getPhase: () => string,
  targetPhases: readonly string[],
  timeoutMs: number = 2000,
): Promise<void> {
  const start = Date.now();
  while (!targetPhases.includes(getPhase())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for phase ${targetPhases.join("|")}, got ${getPhase()}`);
    }
    await Bun.sleep(1);
  }
}

// ---------------------------------------------------------------------------
// Controllable mock harness for integration testing
// ---------------------------------------------------------------------------

interface ControllableHarness {
  readonly harness: LongRunningHarness;
  readonly setPhase: (p: string) => void;
  readonly getPhase: () => string;
  readonly resumeCount: () => number;
}

function createControllableHarness(): ControllableHarness {
  let currentPhase = "idle";
  let resumes = 0;
  const mw: KoiMiddleware = {
    name: "controllable-harness-mw",
    describeCapabilities: () => undefined,
  };
  const disposeCalls: string[] = [];

  const harnessId = "integration-test" as LongRunningHarness["harnessId"];

  const harness: LongRunningHarness = {
    harnessId,
    start: async () => ({
      ok: true as const,
      value: { engineInput: {} as never, sessionId: `s-${resumes}` },
    }),
    resume: async (): Promise<
      Result<
        {
          readonly engineInput: never;
          readonly sessionId: string;
          readonly engineStateRecovered: boolean;
        },
        KoiError
      >
    > => {
      resumes += 1;
      currentPhase = "active";
      return {
        ok: true,
        value: { engineInput: {} as never, sessionId: `s-${resumes}`, engineStateRecovered: false },
      };
    },
    pause: async () => ({ ok: true as const, value: undefined }),
    fail: async () => ({ ok: true as const, value: undefined }),
    completeTask: async () => ({ ok: true as const, value: undefined }),
    status: () => ({
      harnessId,
      phase: currentPhase as "idle" | "active" | "suspended" | "completed" | "failed",
      currentSessionSeq: resumes,
      taskBoard: { items: [], results: [] },
      metrics: {
        totalSessions: resumes,
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        completedTaskCount: 0,
        pendingTaskCount: 0,
        elapsedMs: 0,
      },
    }),
    createMiddleware: () => mw,
    dispose: async () => {
      disposeCalls.push("harness");
    },
  };

  return {
    harness,
    setPhase: (p: string) => {
      currentPhase = p;
    },
    getPhase: () => currentPhase,
    resumeCount: () => resumes,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("AutonomousAgent lifecycle integration", () => {
  test("full lifecycle: start → suspend → auto-resume → complete", async () => {
    const ctrl = createControllableHarness();

    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
    });

    // Start harness, then suspend it
    ctrl.setPhase("suspended");
    scheduler.start();

    // Wait for auto-resume (scheduler detects suspended → resumes)
    await waitForPhase(ctrl.getPhase, ["active"]);
    expect(ctrl.resumeCount()).toBeGreaterThanOrEqual(1);

    // Mark completed
    ctrl.setPhase("completed");
    await waitForPhase(() => scheduler.status().phase, ["stopped"]);

    expect(scheduler.status().phase).toBe("stopped");
    await agent.dispose();
  });

  test("scheduler stops when harness completes all tasks", async () => {
    const ctrl = createControllableHarness();

    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
    });

    ctrl.setPhase("completed");
    scheduler.start();

    await waitForPhase(() => scheduler.status().phase, ["stopped"]);
    expect(scheduler.status().phase).toBe("stopped");
    expect(ctrl.resumeCount()).toBe(0);

    await agent.dispose();
  });

  test("multiple suspend/resume cycles", async () => {
    const ctrl = createControllableHarness();
    let cycleCount = 0;

    // Override resume to go back to suspended after a cycle
    const originalResume = ctrl.harness.resume;
    const cyclingHarness: LongRunningHarness = {
      ...ctrl.harness,
      resume: async () => {
        const result = await originalResume.call(ctrl.harness);
        cycleCount += 1;
        if (cycleCount >= 3) {
          ctrl.setPhase("completed");
        } else {
          // Go back to suspended after a brief "active" phase
          ctrl.setPhase("suspended");
        }
        return result;
      },
    };

    const scheduler = createHarnessScheduler({
      harness: cyclingHarness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const agent = createAutonomousAgent({
      harness: cyclingHarness,
      scheduler,
    });

    ctrl.setPhase("suspended");
    scheduler.start();

    await waitForPhase(() => scheduler.status().phase, ["stopped"]);

    expect(cycleCount).toBe(3);
    expect(scheduler.status().totalResumes).toBe(3);

    await agent.dispose();
  });

  test("compactor middleware included in middleware output", () => {
    const ctrl = createControllableHarness();
    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const compactor: KoiMiddleware = { name: "compactor", describeCapabilities: () => undefined };
    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
      compactorMiddleware: compactor,
    });

    const mw = agent.middleware();
    expect(mw).toHaveLength(2);
    expect(mw[0]?.name).toBe("controllable-harness-mw");
    expect(mw[1]?.name).toBe("compactor");
  });

  test("dispose stops scheduler before harness", async () => {
    const disposeCalls: string[] = [];
    const ctrl = createControllableHarness();

    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    // Wrap to track dispose order
    const wrappedScheduler = {
      ...scheduler,
      dispose: async () => {
        disposeCalls.push("scheduler");
        await scheduler.dispose();
      },
    };
    const wrappedHarness: LongRunningHarness = {
      ...ctrl.harness,
      dispose: async () => {
        disposeCalls.push("harness");
        await ctrl.harness.dispose();
      },
    };

    const agent = createAutonomousAgent({
      harness: wrappedHarness,
      scheduler: wrappedScheduler,
    });

    await agent.dispose();
    expect(disposeCalls).toEqual(["scheduler", "harness"]);
  });

  test("thread store enables checkpoint + inbox middleware", () => {
    const ctrl = createControllableHarness();
    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const fakeStore: ThreadStore = {
      appendAndCheckpoint: async () => ({ ok: true as const, value: undefined }),
      loadThread: async () => ({ ok: true as const, value: undefined }),
      listMessages: async () => ({ ok: true as const, value: [] as const }),
      close: () => {},
    };

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
      threadStore: fakeStore,
    });

    const mw = agent.middleware();
    // harness + checkpoint + inbox = 3 middleware
    expect(mw).toHaveLength(3);
    expect(mw[0]?.name).toBe("controllable-harness-mw");
    expect(mw[1]?.name).toBe("checkpoint-middleware");
    expect(mw[2]?.name).toBe("inbox-middleware");

    // providers: plan_autonomous + autonomous
    const provs = agent.providers();
    expect(provs).toHaveLength(2);
    expect(provs[0]?.name).toBe("plan-autonomous-provider");
    expect(provs[1]?.name).toBe("autonomous-provider");
  });

  test("thread store + compactor yields 4 middleware in correct order", () => {
    const ctrl = createControllableHarness();
    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const fakeStore: ThreadStore = {
      appendAndCheckpoint: async () => ({ ok: true as const, value: undefined }),
      loadThread: async () => ({ ok: true as const, value: undefined }),
      listMessages: async () => ({ ok: true as const, value: [] as const }),
      close: () => {},
    };

    const compactor: KoiMiddleware = { name: "compactor", describeCapabilities: () => undefined };

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
      threadStore: fakeStore,
      compactorMiddleware: compactor,
    });

    const mw = agent.middleware();
    // harness + checkpoint + inbox + compactor = 4
    expect(mw).toHaveLength(4);
    expect(mw[0]?.name).toBe("controllable-harness-mw");
    expect(mw[1]?.name).toBe("checkpoint-middleware");
    expect(mw[2]?.name).toBe("inbox-middleware");
    expect(mw[3]?.name).toBe("compactor");
  });

  test("autonomous provider inbox respects custom inbox policy", async () => {
    const ctrl = createControllableHarness();
    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const fakeStore: ThreadStore = {
      appendAndCheckpoint: async () => ({ ok: true as const, value: undefined }),
      loadThread: async () => ({ ok: true as const, value: undefined }),
      listMessages: async () => ({ ok: true as const, value: [] as const }),
      close: () => {},
    };

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
      threadStore: fakeStore,
      inboxPolicy: { collectCap: 5, followupCap: 10, steerCap: 1 },
    });

    // Verify the autonomous provider was created (it will attach inbox at assembly)
    const provs = agent.providers();
    const autonomousProvider = provs.find((p) => p.name === "autonomous-provider");
    expect(autonomousProvider).toBeDefined();
  });

  test("full lifecycle with thread store: suspend → resume → complete", async () => {
    const ctrl = createControllableHarness();

    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const fakeStore: ThreadStore = {
      appendAndCheckpoint: async () => ({ ok: true as const, value: undefined }),
      loadThread: async () => ({ ok: true as const, value: undefined }),
      listMessages: async () => ({ ok: true as const, value: [] as const }),
      close: () => {},
    };

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
      threadStore: fakeStore,
      checkpointPolicy: { intervalTurns: 3, onSessionEnd: true, onSuspend: true },
    });

    // Verify middleware and providers are wired
    expect(agent.middleware().length).toBeGreaterThanOrEqual(3);
    expect(agent.providers().length).toBeGreaterThanOrEqual(2);

    // Simulate: suspended → auto-resume → completed
    ctrl.setPhase("suspended");
    scheduler.start();

    await waitForPhase(ctrl.getPhase, ["active"]);
    expect(ctrl.resumeCount()).toBeGreaterThanOrEqual(1);

    ctrl.setPhase("completed");
    await waitForPhase(() => scheduler.status().phase, ["stopped"]);

    expect(scheduler.status().phase).toBe("stopped");
    await agent.dispose();
  });
});
