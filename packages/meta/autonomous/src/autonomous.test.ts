import { describe, expect, test } from "bun:test";
import type { KoiMiddleware, SpawnFn, TaskBoardSnapshot } from "@koi/core";
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
  readonly taskBoard?: TaskBoardSnapshot;
}): LongRunningHarness {
  const disposeCalls = opts?.disposeCalls ?? [];
  const mw = createMockMiddleware(opts?.middlewareName ?? "harness-mw");
  // let justified: mutable board state updated by start/completeTask
  let currentBoard: TaskBoardSnapshot = opts?.taskBoard ?? { items: [], results: [] };

  return {
    harnessId: "test-harness" as LongRunningHarness["harnessId"],
    start: async (plan: TaskBoardSnapshot) => {
      currentBoard = plan;
      return {
        ok: true as const,
        value: { engineInput: {} as never, sessionId: "s1" },
      };
    },
    resume: async () => ({
      ok: true as const,
      value: { engineInput: {} as never, sessionId: "s1", engineStateRecovered: false },
    }),
    pause: async () => ({ ok: true as const, value: undefined }),
    fail: async () => ({ ok: true as const, value: undefined }),
    assignTask: async (taskId) => {
      const task = currentBoard.items.find((i) => i.id === taskId);
      if (task?.status !== "pending") {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION" as const,
            message: `Cannot assign: status is ${task?.status}`,
            retryable: false as const,
          },
        };
      }
      currentBoard = {
        items: currentBoard.items.map((item) =>
          item.id === taskId ? { ...item, status: "assigned" as const } : item,
        ),
        results: currentBoard.results,
      };
      return { ok: true as const, value: undefined };
    },
    completeTask: async (taskId, result) => {
      const task = currentBoard.items.find((i) => i.id === taskId);
      if (task?.status !== "assigned") {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION" as const,
            message: `Cannot complete: status is ${task?.status}`,
            retryable: false as const,
          },
        };
      }
      currentBoard = {
        items: currentBoard.items.map((item) =>
          item.id === taskId ? { ...item, status: "completed" as const } : item,
        ),
        results: [...currentBoard.results, result],
      };
      return { ok: true as const, value: undefined };
    },
    status: () => ({
      harnessId: "test-harness" as LongRunningHarness["harnessId"],
      phase: "idle" as const,
      currentSessionSeq: 0,
      taskBoard: currentBoard,
      metrics: {
        totalSessions: 0,
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        completedTaskCount: currentBoard.items.filter((i) => i.status === "completed").length,
        pendingTaskCount: currentBoard.items.filter((i) => i.status !== "completed").length,
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

  test("onPlanCreated throws when spawn tasks exist but getSpawn returns undefined", async () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({
      harness,
      scheduler,
      // getSpawn returns undefined — no spawn function bound
      getSpawn: () => undefined,
    });

    // Get the plan_autonomous tool via the provider
    const providers = agent.providers();
    const planProvider = providers.find((p) => p.name === "plan-autonomous-provider");
    if (planProvider === undefined) throw new Error("plan-autonomous-provider not found");

    const attachResult = await planProvider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in attachResult ? attachResult.components : attachResult;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    // Plan with spawn tasks should throw
    await expect(
      tool.execute({
        tasks: [{ id: "t1", description: "Spawn task", delegation: "spawn" }],
      }),
    ).rejects.toThrow("Spawn delegation requested but no spawn function is available");
  });

  test("onPlanCreated succeeds when plan has only self-delegated tasks and no getSpawn", async () => {
    const harness = createMockHarness();
    const scheduler = createMockScheduler();
    const agent = createAutonomousAgent({ harness, scheduler });

    const providers = agent.providers();
    const planProvider = providers.find((p) => p.name === "plan-autonomous-provider");
    if (planProvider === undefined) throw new Error("plan-autonomous-provider not found");

    const attachResult = await planProvider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in attachResult ? attachResult.components : attachResult;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    // Self-delegated plan should succeed without getSpawn
    const output = await tool.execute({
      tasks: [
        { id: "t1", description: "Self task" },
        { id: "t2", description: "Another self task", delegation: "self" },
      ],
    });

    expect(output).toEqual({
      status: "plan_created",
      taskCount: 2,
      message: "Created autonomous plan with 2 tasks.",
    });
  });

  test("dispose aborts bridge and then disposes scheduler and harness in order", async () => {
    const disposeCalls: string[] = [];
    const harness = createMockHarness({ disposeCalls });
    const scheduler = createMockScheduler({ disposeCalls });

    const mockSpawn: SpawnFn = async () => ({ ok: true, output: "done" });

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      getSpawn: () => mockSpawn,
    });

    // Trigger plan creation to create the bridge
    const providers = agent.providers();
    const planProvider = providers.find((p) => p.name === "plan-autonomous-provider");
    if (planProvider === undefined) throw new Error("plan-autonomous-provider not found");

    const attachResult = await planProvider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in attachResult ? attachResult.components : attachResult;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    // Create a plan with spawn tasks to trigger bridge creation
    await tool.execute({
      tasks: [{ id: "t1", description: "Spawn task", delegation: "spawn" }],
    });

    // Dispose should: abort bridge, then scheduler, then harness
    await agent.dispose();

    // Verify scheduler disposed before harness
    expect(disposeCalls).toEqual(["scheduler", "harness"]);
  });
});
