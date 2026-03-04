/**
 * Integration tests — AutonomousAgent lifecycle coordination.
 *
 * Uses mock harness + real scheduler + in-memory stores to test
 * the full lifecycle: start → suspend → auto-resume → complete → dispose.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  HandoffEnvelope,
  HarnessSnapshot,
  HarnessSnapshotStore,
  KoiError,
  KoiMiddleware,
  Result,
  SnapshotNode,
  ThreadStore,
} from "@koi/core";
import { agentId, taskItemId } from "@koi/core";
import { createInMemoryHandoffStore } from "@koi/handoff";
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

  test("handoff bridge fires when harness completes (manual)", async () => {
    const ctrl = createControllableHarness();
    const TARGET_AGENT: AgentId = agentId("agent-target");

    // Build a completed snapshot for the mock harness store
    const completedSnapshot: HarnessSnapshot = {
      harnessId: ctrl.harness.harnessId,
      phase: "completed",
      sessionSeq: 2,
      taskBoard: {
        items: [],
        results: [{ taskId: taskItemId("task-1"), output: "Done", durationMs: 5000 }],
      },
      summaries: [
        {
          narrative: "Analysis completed successfully",
          sessionSeq: 1,
          completedTaskIds: ["task-1"],
          estimatedTokens: 500,
          generatedAt: Date.now(),
        },
      ],
      keyArtifacts: [
        {
          toolName: "file_write",
          content: "output data",
          turnIndex: 3,
          capturedAt: Date.now(),
        },
      ],
      agentId: "agent-a",
      metrics: {
        totalSessions: 2,
        totalTurns: 10,
        totalInputTokens: 5000,
        totalOutputTokens: 2500,
        completedTaskCount: 1,
        pendingTaskCount: 0,
        elapsedMs: 60000,
      },
      startedAt: Date.now() - 60000,
      checkpointedAt: Date.now(),
    };

    const snapshotNode: SnapshotNode<HarnessSnapshot> = {
      nodeId: "node-1" as never,
      chainId: ctrl.harness.harnessId as never,
      parentIds: [],
      contentHash: "hash-1",
      data: completedSnapshot,
      createdAt: Date.now(),
      metadata: {},
    };

    const mockHarnessStore: HarnessSnapshotStore = {
      head: () => Promise.resolve({ ok: true, value: snapshotNode }),
      put: () => Promise.resolve({ ok: true, value: undefined }),
      get: () => Promise.resolve({ ok: true, value: snapshotNode }),
      list: () => Promise.resolve({ ok: true, value: [snapshotNode] }),
      ancestors: () => Promise.resolve({ ok: true, value: [] }),
      fork: () => Promise.resolve({ ok: true, value: {} as never }),
      prune: () => Promise.resolve({ ok: true, value: 0 }),
      close: () => {},
    };

    const handoffStore = createInMemoryHandoffStore();

    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
      handoffBridge: {
        harnessStore: mockHarnessStore,
        handoffStore,
        targetAgentId: TARGET_AGENT,
        nextPhaseInstructions: "Deploy the results",
      },
      autoFireBridge: false, // manual-only mode
    });

    // Verify bridge exists
    const bridge = agent.handoffBridge;
    expect(bridge).toBeDefined();
    expect(bridge?.hasFired()).toBe(false);

    // Simulate: harness reaches completed state
    ctrl.setPhase("completed");
    scheduler.start();
    await waitForPhase(() => scheduler.status().phase, ["stopped"]);

    // Fire the bridge manually
    const result = await bridge?.onHarnessCompleted();
    expect(result?.ok).toBe(true);
    expect(bridge?.hasFired()).toBe(true);

    // Verify envelope is in the handoff store
    if (result?.ok) {
      const getResult = await handoffStore.get(result.value);
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.to).toBe(TARGET_AGENT);
        expect(getResult.value.phase.next).toBe("Deploy the results");
        expect(getResult.value.context.artifacts).toHaveLength(1);
        expect(getResult.value.context.decisions).toHaveLength(1);
      }
    }

    await agent.dispose();
  });

  test("autonomous agent without handoff bridge has no bridge property", () => {
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

    expect(agent.handoffBridge).toBeUndefined();
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

  test("bridge auto-fires without manual onHarnessCompleted() call", async () => {
    const ctrl = createControllableHarness();
    const TARGET_AGENT: AgentId = agentId("agent-auto");

    const completedSnapshot: HarnessSnapshot = {
      harnessId: ctrl.harness.harnessId,
      phase: "completed",
      sessionSeq: 1,
      taskBoard: {
        items: [],
        results: [{ taskId: taskItemId("task-1"), output: "Done", durationMs: 3000 }],
      },
      summaries: [],
      keyArtifacts: [],
      agentId: "agent-a",
      metrics: {
        totalSessions: 1,
        totalTurns: 5,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        completedTaskCount: 1,
        pendingTaskCount: 0,
        elapsedMs: 30000,
      },
      startedAt: Date.now() - 30000,
      checkpointedAt: Date.now(),
    };

    const snapshotNode: SnapshotNode<HarnessSnapshot> = {
      nodeId: "node-auto" as never,
      chainId: ctrl.harness.harnessId as never,
      parentIds: [],
      contentHash: "hash-auto",
      data: completedSnapshot,
      createdAt: Date.now(),
      metadata: {},
    };

    const mockHarnessStore: HarnessSnapshotStore = {
      head: () => Promise.resolve({ ok: true, value: snapshotNode }),
      put: () => Promise.resolve({ ok: true, value: undefined }),
      get: () => Promise.resolve({ ok: true, value: snapshotNode }),
      list: () => Promise.resolve({ ok: true, value: [snapshotNode] }),
      ancestors: () => Promise.resolve({ ok: true, value: [] }),
      fork: () => Promise.resolve({ ok: true, value: {} as never }),
      prune: () => Promise.resolve({ ok: true, value: 0 }),
      close: () => {},
    };

    const handoffStore = createInMemoryHandoffStore();

    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
      handoffBridge: {
        harnessStore: mockHarnessStore,
        handoffStore,
        targetAgentId: TARGET_AGENT,
      },
      // autoFireBridge defaults to true
    });

    const bridge = agent.handoffBridge;
    expect(bridge).toBeDefined();

    // Simulate: harness reaches completed → scheduler stops → auto-fire triggers
    ctrl.setPhase("completed");
    scheduler.start();
    await waitForPhase(() => scheduler.status().phase, ["stopped"]);

    // Wait a tick for the auto-fire watcher to detect "stopped" and fire
    await Bun.sleep(50);

    expect(bridge?.hasFired()).toBe(true);

    await agent.dispose();
  });

  test("manual fire before auto-fire is idempotent", async () => {
    const ctrl = createControllableHarness();
    const TARGET_AGENT: AgentId = agentId("agent-idem");

    const completedSnapshot: HarnessSnapshot = {
      harnessId: ctrl.harness.harnessId,
      phase: "completed",
      sessionSeq: 1,
      taskBoard: { items: [], results: [] },
      summaries: [],
      keyArtifacts: [],
      agentId: "agent-a",
      metrics: {
        totalSessions: 1,
        totalTurns: 3,
        totalInputTokens: 500,
        totalOutputTokens: 250,
        completedTaskCount: 0,
        pendingTaskCount: 0,
        elapsedMs: 10000,
      },
      startedAt: Date.now() - 10000,
      checkpointedAt: Date.now(),
    };

    const snapshotNode: SnapshotNode<HarnessSnapshot> = {
      nodeId: "node-idem" as never,
      chainId: ctrl.harness.harnessId as never,
      parentIds: [],
      contentHash: "hash-idem",
      data: completedSnapshot,
      createdAt: Date.now(),
      metadata: {},
    };

    // let justified: track put call count for idempotency verification
    let putCount = 0;
    const mockHarnessStore: HarnessSnapshotStore = {
      head: () => Promise.resolve({ ok: true, value: snapshotNode }),
      put: () => Promise.resolve({ ok: true, value: undefined }),
      get: () => Promise.resolve({ ok: true, value: snapshotNode }),
      list: () => Promise.resolve({ ok: true, value: [snapshotNode] }),
      ancestors: () => Promise.resolve({ ok: true, value: [] }),
      fork: () => Promise.resolve({ ok: true, value: {} as never }),
      prune: () => Promise.resolve({ ok: true, value: 0 }),
      close: () => {},
    };

    const handoffStore = createInMemoryHandoffStore();
    const originalPut = handoffStore.put.bind(handoffStore);
    handoffStore.put = (envelope: HandoffEnvelope) => {
      putCount += 1;
      return originalPut(envelope);
    };

    const scheduler = createHarnessScheduler({
      harness: ctrl.harness,
      pollIntervalMs: 10,
      delay: immediateDelay,
    });

    const agent = createAutonomousAgent({
      harness: ctrl.harness,
      scheduler,
      handoffBridge: {
        harnessStore: mockHarnessStore,
        handoffStore,
        targetAgentId: TARGET_AGENT,
      },
    });

    const bridge = agent.handoffBridge;
    expect(bridge).toBeDefined();

    // Manually fire BEFORE scheduler starts
    const manualResult = await bridge?.onHarnessCompleted();
    expect(manualResult.ok).toBe(true);
    expect(putCount).toBe(1);

    // Now start scheduler — auto-fire should detect hasFired() and skip
    ctrl.setPhase("completed");
    scheduler.start();
    await waitForPhase(() => scheduler.status().phase, ["stopped"]);
    await Bun.sleep(50);

    // Put should still be 1 — auto-fire did not re-fire
    expect(putCount).toBe(1);

    await agent.dispose();
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
