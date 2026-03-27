import { describe, expect, test } from "bun:test";
import type { KoiMiddleware } from "@koi/core";
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

  test("middleware includes collectiveMemoryMiddleware when provided", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const collectiveMemory = createMockMiddleware("collective-memory-mw");
    const agent = createAutonomousAgent({
      harness,
      scheduler,
      collectiveMemoryMiddleware: collectiveMemory,
    });

    const mw = agent.middleware();
    expect(mw).toHaveLength(2);
    expect(mw[0]?.name).toBe("lr-mw");
    expect(mw[1]?.name).toBe("collective-memory-mw");
  });

  test("middleware includes both compactor and collectiveMemory when both provided", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const compactor = createMockMiddleware("compactor-mw");
    const collectiveMemory = createMockMiddleware("collective-memory-mw");
    const agent = createAutonomousAgent({
      harness,
      scheduler,
      compactorMiddleware: compactor,
      collectiveMemoryMiddleware: collectiveMemory,
    });

    const mw = agent.middleware();
    expect(mw).toHaveLength(3);
    expect(mw[0]?.name).toBe("lr-mw");
    expect(mw[1]?.name).toBe("compactor-mw");
    expect(mw[2]?.name).toBe("collective-memory-mw");
  });

  test("providers returns plan_autonomous and task-tools providers by default", () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler });

    const provs = agent.providers();
    expect(provs).toHaveLength(2);
    expect(provs[0]?.name).toBe("plan-autonomous-provider");
    expect(provs[1]?.name).toBe("task-tools-provider");
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
    expect(provs).toHaveLength(3); // plan_autonomous + task-tools + autonomous
    expect(provs[0]?.name).toBe("plan-autonomous-provider");
    expect(provs[1]?.name).toBe("task-tools-provider");
    expect(provs[2]?.name).toBe("autonomous-provider");
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

  test("middleware includes reportMiddleware when provided", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const report = createMockMiddleware("report-mw");
    const agent = createAutonomousAgent({ harness, scheduler, reportMiddleware: report });

    const mw = agent.middleware();
    expect(mw).toHaveLength(2);
    expect(mw[0]?.name).toBe("lr-mw");
    expect(mw[1]?.name).toBe("report-mw");
  });

  test("middleware includes eventTraceMiddleware when provided", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const eventTrace = createMockMiddleware("event-trace-mw");
    const agent = createAutonomousAgent({ harness, scheduler, eventTraceMiddleware: eventTrace });

    const mw = agent.middleware();
    expect(mw).toHaveLength(2);
    expect(mw[0]?.name).toBe("lr-mw");
    expect(mw[1]?.name).toBe("event-trace-mw");
  });

  test("middleware includes both report and event-trace when both provided", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const eventTrace = createMockMiddleware("event-trace-mw");
    const report = createMockMiddleware("report-mw");
    const agent = createAutonomousAgent({
      harness,
      scheduler,
      eventTraceMiddleware: eventTrace,
      reportMiddleware: report,
    });

    const mw = agent.middleware();
    expect(mw).toHaveLength(3);
    expect(mw[0]?.name).toBe("lr-mw");
    expect(mw[1]?.name).toBe("event-trace-mw");
    expect(mw[2]?.name).toBe("report-mw");
  });

  test("middleware includes goalStackMiddleware entries when provided", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const goalMw1 = createMockMiddleware("goal-reminder");
    const goalMw2 = createMockMiddleware("goal-anchor");
    const agent = createAutonomousAgent({
      harness,
      scheduler,
      goalStackMiddleware: [goalMw1, goalMw2],
    });

    const mw = agent.middleware();
    expect(mw).toHaveLength(3); // harness + 2 goal-stack
    expect(mw[0]?.name).toBe("lr-mw");
    expect(mw[1]?.name).toBe("goal-reminder");
    expect(mw[2]?.name).toBe("goal-anchor");
  });

  test("goalStackMiddleware omitted when not provided (existing behavior)", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler });

    const mw = agent.middleware();
    expect(mw).toHaveLength(1);
    expect(mw[0]?.name).toBe("lr-mw");
  });

  test("taskBoardGoalStack:true auto-wires goal-stack middleware from harness task board", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler, taskBoardGoalStack: true });

    const mw = agent.middleware();
    // goal-stack "autonomous" preset includes reminder + anchor + planning (3 middleware)
    expect(mw.length).toBeGreaterThan(1);
    expect(mw[0]?.name).toBe("lr-mw");
    // goal-reminder should be present (first goal-stack middleware)
    const names = mw.map((m) => m.name);
    expect(names.some((n) => n.includes("reminder") || n.includes("goal"))).toBe(true);
  });

  test("goalStackMiddleware takes precedence over taskBoardGoalStack", () => {
    const harness = createMockHarness({ middlewareName: "lr-mw" });
    const scheduler = createMockScheduler();
    const explicitMw = createMockMiddleware("explicit-goal-mw");
    const agent = createAutonomousAgent({
      harness,
      scheduler,
      goalStackMiddleware: [explicitMw],
      taskBoardGoalStack: true,
    });

    const mw = agent.middleware();
    // Only the explicit goalStackMiddleware is used, not the auto-wired ones
    expect(mw).toHaveLength(2);
    expect(mw[1]?.name).toBe("explicit-goal-mw");
  });

  test("middleware returns cached array (same reference)", () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler });

    const mw1 = agent.middleware();
    const mw2 = agent.middleware();
    expect(mw1).toBe(mw2); // same cached reference
  });
});
