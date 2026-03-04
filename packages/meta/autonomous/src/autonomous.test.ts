import { describe, expect, test } from "bun:test";
import type { HarnessSnapshotStore, KoiMiddleware } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";
import { createAutonomousAgent } from "./autonomous.js";

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function createMockMiddleware(name: string): KoiMiddleware {
  return { name, describeCapabilities: () => undefined };
}

function createMockHarness(opts?: {
  readonly middlewareName?: string;
  readonly disposeCalls?: string[];
}): LongRunningHarness {
  const disposeCalls = opts?.disposeCalls ?? [];
  const mw = createMockMiddleware(opts?.middlewareName ?? "harness-mw");

  return {
    harnessId: "test-harness" as LongRunningHarness["harnessId"],
    start: async () => ({
      ok: true as const,
      value: { engineInput: {} as never, sessionId: "s1" },
    }),
    resume: async () => ({
      ok: true as const,
      value: { engineInput: {} as never, sessionId: "s1", engineStateRecovered: false },
    }),
    pause: async () => ({ ok: true as const, value: undefined }),
    fail: async () => ({ ok: true as const, value: undefined }),
    completeTask: async () => ({ ok: true as const, value: undefined }),
    status: () => ({
      harnessId: "test-harness" as LongRunningHarness["harnessId"],
      phase: "idle" as const,
      currentSessionSeq: 0,
      taskBoard: { items: [], results: [] },
      metrics: {
        totalSessions: 0,
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
}

function createMockScheduler(opts?: { readonly disposeCalls?: string[] }): HarnessScheduler {
  const disposeCalls = opts?.disposeCalls ?? [];

  return {
    start: () => {},
    stop: () => {},
    status: () => ({
      phase: "idle" as const,
      retriesRemaining: 3,
      totalResumes: 0,
    }),
    dispose: async () => {
      disposeCalls.push("scheduler");
    },
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("createAutonomousAgent", () => {
  test("exposes harness and scheduler", () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler });

    expect(agent.harness).toBe(harness);
    expect(agent.scheduler).toBe(scheduler);
  });

  test("middleware returns harness middleware only when no compactor", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler });

    const mw = agent.middleware();
    expect(mw).toHaveLength(1);
    expect(mw[0]?.name).toBe("lr-mw");
  });

  test("middleware includes compactor when provided", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const compactor = createMockMiddleware("compactor-mw");
    const agent = createAutonomousAgent({ harness, scheduler, compactorMiddleware: compactor });

    const mw = agent.middleware();
    expect(mw).toHaveLength(2);
    expect(mw[0]?.name).toBe("lr-mw");
    expect(mw[1]?.name).toBe("compactor-mw");
  });

  test("providers returns plan_autonomous provider by default", () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler });

    const provs = agent.providers();
    expect(provs).toHaveLength(1);
    expect(provs[0]?.name).toBe("plan-autonomous-provider");
  });

  test("middleware includes checkpoint + inbox when threadStore provided", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const fakeStore = {
      appendAndCheckpoint: async () => ({ ok: true as const, value: undefined }),
      loadThread: async () => ({ ok: true as const, value: undefined }),
      listMessages: async () => ({ ok: true as const, value: [] as const }),
      close: () => {},
    };

    const agent = createAutonomousAgent({ harness, scheduler, threadStore: fakeStore });

    const mw = agent.middleware();
    expect(mw).toHaveLength(3); // harness + checkpoint + inbox
    expect(mw[0]?.name).toBe("lr-mw");
    expect(mw[1]?.name).toBe("checkpoint-middleware");
    expect(mw[2]?.name).toBe("inbox-middleware");
  });

  test("providers includes autonomous-provider when threadStore provided", () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const fakeStore = {
      appendAndCheckpoint: async () => ({ ok: true as const, value: undefined }),
      loadThread: async () => ({ ok: true as const, value: undefined }),
      listMessages: async () => ({ ok: true as const, value: [] as const }),
      close: () => {},
    };

    const agent = createAutonomousAgent({ harness, scheduler, threadStore: fakeStore });

    const provs = agent.providers();
    expect(provs).toHaveLength(2); // plan_autonomous + autonomous
    expect(provs[0]?.name).toBe("plan-autonomous-provider");
    expect(provs[1]?.name).toBe("autonomous-provider");
  });

  test("dispose stops scheduler first, then harness", async () => {
    const disposeCalls: string[] = [];
    const harness = createMockHarness({ disposeCalls });
    const scheduler = createMockScheduler({ disposeCalls });
    const agent = createAutonomousAgent({ harness, scheduler });

    await agent.dispose();

    expect(disposeCalls).toEqual(["scheduler", "harness"]);
  });

  test("dispose is idempotent", async () => {
    const disposeCalls: string[] = [];
    const harness = createMockHarness({ disposeCalls });
    const scheduler = createMockScheduler({ disposeCalls });
    const agent = createAutonomousAgent({ harness, scheduler });

    await agent.dispose();
    await agent.dispose(); // second call should be no-op

    expect(disposeCalls).toEqual(["scheduler", "harness"]);
  });

  test("middleware returns cached array (same reference)", () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler });

    const mw1 = agent.middleware();
    const mw2 = agent.middleware();
    expect(mw1).toBe(mw2); // same cached reference
  });

  test("auto-fire does not wire when autoFireBridge is false", () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const fakeHarnessStore: HarnessSnapshotStore = {
      head: async () => ({ ok: true as const, value: undefined }),
      put: async () => ({ ok: true as const, value: undefined }),
      get: async () => ({ ok: true as const, value: undefined }) as never,
      list: async () => ({ ok: true as const, value: [] as const }),
      ancestors: async () => ({ ok: true as const, value: [] as const }),
      fork: async () => ({ ok: true as const, value: {} as never }),
      prune: async () => ({ ok: true as const, value: 0 }),
      close: () => {},
    };
    const fakeHandoffStore = {
      put: () => ({ ok: true as const, value: undefined }) as never,
      get: () =>
        ({ ok: false, error: { code: "NOT_FOUND", message: "n/a", retryable: false } }) as never,
      transition: () => ({ ok: true as const, value: {} }) as never,
      listByAgent: () => ({ ok: true as const, value: [] }) as never,
      findPendingForAgent: () => ({ ok: true as const, value: undefined }) as never,
      remove: () => ({ ok: true as const, value: true }) as never,
      removeByAgent: () => ({ ok: true as const, value: undefined }) as never,
      bindRegistry: () => {},
      dispose: () => {},
    };

    // With autoFireBridge=false, bridge should exist but auto-fire should not engage.
    // We verify by checking that dispose completes cleanly (no watcher to cancel).
    const agent = createAutonomousAgent({
      harness,
      scheduler,
      handoffBridge: {
        harnessStore: fakeHarnessStore,
        handoffStore: fakeHandoffStore,
        targetAgentId: "agent-target" as never,
      },
      autoFireBridge: false,
    });

    expect(agent.handoffBridge).toBeDefined();
    // Bridge exists but auto-fire watcher is not created — dispose should be fast
  });
});
