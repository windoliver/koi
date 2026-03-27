/**
 * Integration tests — Delegation bridge pipeline through AutonomousAgent.
 *
 * Tests the full flow: plan_autonomous with delegation:"spawn" tasks →
 * bridge hydrates board → dispatches spawn tasks → results cascade →
 * harness snapshot updated.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, SpawnFn, SpawnRequest, TaskBoardSnapshot, TaskResult } from "@koi/core";
import { taskItemId } from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";
import { createAutonomousAgent } from "../autonomous.js";

// ---------------------------------------------------------------------------
// Mock agent helper (for provider.attach)
// ---------------------------------------------------------------------------

function createMockAgent(): Agent {
  return {
    pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    state: "created",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

// ---------------------------------------------------------------------------
// Controllable mock harness for integration testing
// ---------------------------------------------------------------------------

function createIntegrationHarness(): {
  readonly harness: LongRunningHarness;
  readonly getBoard: () => TaskBoardSnapshot;
  readonly getCompletedTasks: () => readonly TaskResult[];
} {
  // let justified: mutable state for test harness
  let board: TaskBoardSnapshot = { items: [], results: [] };

  const harness: LongRunningHarness = {
    harnessId: "integration-test" as LongRunningHarness["harnessId"],
    start: async (plan: TaskBoardSnapshot) => {
      board = plan;
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
      const task = board.items.find((i) => i.id === taskId);
      if (task?.status !== "pending") {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION" as const,
            message: `Cannot assign task ${taskId}: expected "pending", got "${task?.status}"`,
            retryable: false as const,
          },
        };
      }
      board = {
        items: board.items.map((item) =>
          item.id === taskId ? { ...item, status: "assigned" as const } : item,
        ),
        results: board.results,
      };
      return { ok: true as const, value: undefined };
    },
    completeTask: async (taskId, result) => {
      const task = board.items.find((i) => i.id === taskId);
      if (task?.status !== "assigned") {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION" as const,
            message: `Cannot complete task ${taskId}: expected "assigned", got "${task?.status}"`,
            retryable: false as const,
          },
        };
      }
      board = {
        items: board.items.map((item) =>
          item.id === taskId ? { ...item, status: "completed" as const } : item,
        ),
        results: [...board.results, result],
      };
      return { ok: true as const, value: undefined };
    },
    status: () => ({
      harnessId: "integration-test" as LongRunningHarness["harnessId"],
      phase: "active" as const,
      currentSessionSeq: 1,
      taskBoard: board,
      metrics: {
        totalSessions: 1,
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        completedTaskCount: board.items.filter((i) => i.status === "completed").length,
        pendingTaskCount: board.items.filter((i) => i.status !== "completed").length,
        elapsedMs: 0,
      },
    }),
    createMiddleware: () => ({
      name: "integration-harness-mw",
      describeCapabilities: () => undefined,
    }),
    dispose: async () => {},
  };

  return {
    harness,
    getBoard: () => board,
    getCompletedTasks: () => board.results,
  };
}

function createMockScheduler(): HarnessScheduler {
  return {
    start: () => {},
    stop: () => {},
    status: () => ({
      phase: "idle" as const,
      retriesRemaining: 3,
      totalResumes: 0,
    }),
    dispose: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Helper to get plan_autonomous tool from agent
// ---------------------------------------------------------------------------

async function getPlanTool(agent: ReturnType<typeof createAutonomousAgent>): Promise<{
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}> {
  const providers = agent.providers();
  const planProvider = providers.find((p) => p.name === "plan-autonomous-provider");
  if (planProvider === undefined) throw new Error("plan-autonomous-provider not found");

  const attachResult = await planProvider.attach(createMockAgent());
  const components = "components" in attachResult ? attachResult.components : attachResult;
  const tool = components.get("tool:plan_autonomous");
  if (tool === undefined) throw new Error("plan_autonomous tool not found");
  return tool as { execute: (args: Record<string, unknown>) => Promise<unknown> };
}

async function getTaskCompleteTool(agent: ReturnType<typeof createAutonomousAgent>): Promise<{
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}> {
  const providers = agent.providers();
  const toolsProvider = providers.find((p) => p.name === "task-tools-provider");
  if (toolsProvider === undefined) throw new Error("task-tools-provider not found");

  const attachResult = await toolsProvider.attach(createMockAgent());
  const components = "components" in attachResult ? attachResult.components : attachResult;
  const tool = components.get("tool:task_complete");
  if (tool === undefined) throw new Error("task_complete tool not found");
  return tool as { execute: (args: Record<string, unknown>) => Promise<unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delegation pipeline integration", () => {
  test("spawn tasks are dispatched via bridge on plan creation", async () => {
    const { harness, getCompletedTasks } = createIntegrationHarness();
    const scheduler = createMockScheduler();
    const spawnCalls: SpawnRequest[] = [];

    const mockSpawn: SpawnFn = async (req) => {
      spawnCalls.push(req);
      return { ok: true, output: `Result of ${req.taskId ?? "unknown"}` };
    };

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      getSpawn: () => mockSpawn,
    });

    const planTool = await getPlanTool(agent);
    await planTool.execute({
      tasks: [
        {
          id: "research",
          description: "Research APIs",
          delegation: "spawn",
          agentType: "researcher",
        },
        { id: "self-task", description: "Self task" },
      ],
    });

    // Only the spawn task should have been dispatched
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.taskId).toBe(taskItemId("research"));
    expect(spawnCalls[0]?.agentName).toBe("researcher");

    // The spawn task result should be written back to harness
    const completed = getCompletedTasks();
    expect(completed.some((r) => r.taskId === taskItemId("research"))).toBe(true);
  });

  test("cascade dispatches downstream spawn tasks after self-delegated task completes", async () => {
    const { harness, getBoard } = createIntegrationHarness();
    const scheduler = createMockScheduler();
    const spawnCalls: SpawnRequest[] = [];

    const mockSpawn: SpawnFn = async (req) => {
      spawnCalls.push(req);
      return { ok: true, output: `Result of ${req.taskId ?? "unknown"}` };
    };

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      getSpawn: () => mockSpawn,
    });

    const planTool = await getPlanTool(agent);
    const taskCompleteTool = await getTaskCompleteTool(agent);

    // Plan: self-task → spawn-task (spawn depends on self)
    await planTool.execute({
      tasks: [
        { id: "self-first", description: "Self task runs first", delegation: "self" },
        {
          id: "spawn-after",
          description: "Spawn after self completes",
          delegation: "spawn",
          agentType: "worker",
          dependencies: ["self-first"],
        },
      ],
    });

    // No spawn calls yet — spawn-after is blocked by self-first
    expect(spawnCalls).toHaveLength(0);

    // Complete the self-delegated task — this should cascade to spawn-after
    await taskCompleteTool.execute({
      task_id: "self-first",
      output: "Self task done",
    });

    // Now spawn-after should have been dispatched
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.taskId).toBe(taskItemId("spawn-after"));

    // Both tasks should be completed in the board
    const board = getBoard();
    const allCompleted = board.items.every((i) => i.status === "completed");
    expect(allCompleted).toBe(true);
  });

  test("independent spawn tasks are dispatched together on plan creation", async () => {
    const { harness } = createIntegrationHarness();
    const scheduler = createMockScheduler();
    const spawnCalls: SpawnRequest[] = [];

    const mockSpawn: SpawnFn = async (req) => {
      spawnCalls.push(req);
      return { ok: true, output: `Result of ${req.taskId ?? "unknown"}` };
    };

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      getSpawn: () => mockSpawn,
    });

    const planTool = await getPlanTool(agent);
    await planTool.execute({
      tasks: [
        { id: "a", description: "Task A", delegation: "spawn" },
        { id: "b", description: "Task B", delegation: "spawn" },
        { id: "c", description: "Task C", delegation: "spawn" },
      ],
    });

    // All three independent tasks should be dispatched
    expect(spawnCalls).toHaveLength(3);
    const dispatched = new Set(spawnCalls.map((c) => c.taskId));
    expect(dispatched.has(taskItemId("a"))).toBe(true);
    expect(dispatched.has(taskItemId("b"))).toBe(true);
    expect(dispatched.has(taskItemId("c"))).toBe(true);
  });

  test("self-only plan works without getSpawn", async () => {
    const { harness, getBoard } = createIntegrationHarness();
    const scheduler = createMockScheduler();

    // No getSpawn — self-delegation only
    const agent = createAutonomousAgent({ harness, scheduler });

    const planTool = await getPlanTool(agent);
    const output = await planTool.execute({
      tasks: [
        { id: "t1", description: "Self task" },
        { id: "t2", description: "Another", dependencies: ["t1"] },
      ],
    });

    expect(output).toEqual({
      status: "plan_created",
      taskCount: 2,
      message: "Created autonomous plan with 2 tasks.",
    });

    // Board should have 2 assigned tasks
    const board = getBoard();
    expect(board.items).toHaveLength(2);
    expect(board.items.every((i) => i.status === "assigned")).toBe(true);
  });

  test("deep dependency chain cascades correctly through mixed delegation", async () => {
    const { harness, getBoard } = createIntegrationHarness();
    const scheduler = createMockScheduler();
    const spawnCalls: SpawnRequest[] = [];

    const mockSpawn: SpawnFn = async (req) => {
      spawnCalls.push(req);
      return { ok: true, output: `Result of ${req.taskId ?? "unknown"}` };
    };

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      getSpawn: () => mockSpawn,
    });

    const planTool = await getPlanTool(agent);
    const taskCompleteTool = await getTaskCompleteTool(agent);

    // Chain: spawn-A → self-B → spawn-C
    await planTool.execute({
      tasks: [
        { id: "a", description: "Spawn root", delegation: "spawn" },
        { id: "b", description: "Self middle", delegation: "self", dependencies: ["a"] },
        { id: "c", description: "Spawn leaf", delegation: "spawn", dependencies: ["b"] },
      ],
    });

    // A should be dispatched immediately (no deps, spawn)
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.taskId).toBe(taskItemId("a"));

    // B is self-delegated and depends on A — won't auto-dispatch
    // Complete B manually
    await taskCompleteTool.execute({
      task_id: "b",
      output: "Self task B done",
    });

    // Now C should be dispatched (spawn, depends on B which is now completed)
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]?.taskId).toBe(taskItemId("c"));

    // All tasks completed
    const board = getBoard();
    expect(board.items.every((i) => i.status === "completed")).toBe(true);
  });
});
