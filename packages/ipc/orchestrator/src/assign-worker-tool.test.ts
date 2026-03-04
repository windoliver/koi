import { describe, expect, test } from "bun:test";
import type { AgentId, TaskBoard } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createAssignWorkerExecutor } from "./assign-worker-tool.js";
import { createTaskBoard } from "./board.js";
import type { BoardHolder } from "./orchestrate-tool.js";
import type { OrchestratorConfig, SpawnWorkerRequest, SpawnWorkerResult } from "./types.js";

function createHolder(board?: TaskBoard): BoardHolder {
  // let justified: mutable board reference
  let b: TaskBoard = board ?? createTaskBoard();
  return {
    getBoard: () => b,
    setBoard: (nb: TaskBoard) => {
      b = nb;
    },
  };
}

const controller = new AbortController();

describe("executeAssignWorker", () => {
  test("assigns a ready task and spawns worker", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r = board.add({ id: taskItemId("a"), description: "Task A" });
    if (!r.ok) throw new Error("setup failed");
    const holder = createHolder(r.value);

    const config: OrchestratorConfig = {
      spawn: async () => ({ ok: true, output: "result-a" }),
    };

    const result = await executeAssignWorker({ task_id: "a" }, holder, config, controller.signal);
    expect(result).toContain("completed");
    expect(result).toContain("result-a");
    expect(holder.getBoard().completed()).toHaveLength(1);
  });

  test("returns error at concurrency limit", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r1 = board.addAll([
      { id: taskItemId("a"), description: "A" },
      { id: taskItemId("b"), description: "B" },
    ]);
    if (!r1.ok) throw new Error("setup failed");
    const r2 = r1.value.assign(taskItemId("a"), "worker-0" as AgentId);
    if (!r2.ok) throw new Error("setup failed");
    const holder = createHolder(r2.value);

    const config: OrchestratorConfig = {
      spawn: async () => ({ ok: true, output: "done" }),
      maxConcurrency: 1,
    };

    const result = await executeAssignWorker({ task_id: "b" }, holder, config, controller.signal);
    expect(result).toContain("Concurrency limit");
  });

  test("returns error for non-ready task", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r = board.addAll([
      { id: taskItemId("a"), description: "A" },
      { id: taskItemId("b"), description: "B", dependencies: [taskItemId("a")] },
    ]);
    if (!r.ok) throw new Error("setup failed");
    const holder = createHolder(r.value);

    const config: OrchestratorConfig = {
      spawn: async () => ({ ok: true, output: "done" }),
    };

    const result = await executeAssignWorker({ task_id: "b" }, holder, config, controller.signal);
    expect(result).toContain("Cannot assign");
  });

  test("handles spawn failure with retry", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard({ maxRetries: 3 });
    const r = board.add({ id: taskItemId("a"), description: "A" });
    if (!r.ok) throw new Error("setup failed");
    const holder = createHolder(r.value);

    const config: OrchestratorConfig = {
      spawn: async () => ({
        ok: false,
        error: { code: "EXTERNAL" as const, message: "network error", retryable: true },
      }),
    };

    const result = await executeAssignWorker({ task_id: "a" }, holder, config, controller.signal);
    expect(result).toContain("retrying");
    expect(holder.getBoard().get(taskItemId("a"))?.status).toBe("pending");
    expect(holder.getBoard().get(taskItemId("a"))?.retries).toBe(1);
  });

  test("returns error for invalid input", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const holder = createHolder();
    const config: OrchestratorConfig = {
      spawn: async () => ({ ok: true, output: "done" }),
    };
    const result = await executeAssignWorker({}, holder, config, controller.signal);
    expect(result).toContain("task_id");
  });

  test("returns error when signal is aborted", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r = board.add({ id: taskItemId("a"), description: "Task A" });
    if (!r.ok) throw new Error("setup failed");
    const holder = createHolder(r.value);

    const config: OrchestratorConfig = {
      spawn: async () => ({ ok: true, output: "done" }),
    };

    const abortController = new AbortController();
    abortController.abort("orchestration timeout");

    const result = await executeAssignWorker(
      { task_id: "a" },
      holder,
      config,
      abortController.signal,
    );
    expect(result).toContain("timed out");
  });

  test("passes structured fields from spawn result to board.complete()", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r = board.add({ id: taskItemId("a"), description: "Task A" });
    if (!r.ok) throw new Error("setup failed");
    const holder = createHolder(r.value);

    const spawnResult: SpawnWorkerResult = {
      ok: true,
      output: "done",
      artifacts: [{ id: "art-1", kind: "file", uri: "file:///out.json" }],
      decisions: [{ agentId: "w1" as AgentId, action: "chose X", reasoning: "best", timestamp: 1 }],
      warnings: ["disk almost full"],
    };

    const config: OrchestratorConfig = {
      spawn: async () => spawnResult,
    };

    await executeAssignWorker({ task_id: "a" }, holder, config, controller.signal);

    const completed = holder.getBoard().completed();
    expect(completed).toHaveLength(1);
    const taskResult = completed[0];
    expect(taskResult).toBeDefined();
    expect(taskResult?.artifacts).toHaveLength(1);
    expect(taskResult?.artifacts?.[0]?.id).toBe("art-1");
    expect(taskResult?.decisions).toHaveLength(1);
    expect(taskResult?.decisions?.[0]?.action).toBe("chose X");
    expect(taskResult?.warnings).toEqual(["disk almost full"]);
  });

  test("omits undefined structured fields", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r = board.add({ id: taskItemId("a"), description: "Task A" });
    if (!r.ok) throw new Error("setup failed");
    const holder = createHolder(r.value);

    const config: OrchestratorConfig = {
      spawn: async () => ({ ok: true, output: "plain result" }),
    };

    await executeAssignWorker({ task_id: "a" }, holder, config, controller.signal);

    const completed = holder.getBoard().completed();
    expect(completed).toHaveLength(1);
    const taskResult = completed[0];
    expect(taskResult).toBeDefined();
    expect(taskResult?.artifacts).toBeUndefined();
    expect(taskResult?.decisions).toBeUndefined();
    expect(taskResult?.warnings).toBeUndefined();
  });

  test("measures actual durationMs (non-zero)", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r = board.add({ id: taskItemId("a"), description: "Task A" });
    if (!r.ok) throw new Error("setup failed");
    const holder = createHolder(r.value);

    const config: OrchestratorConfig = {
      spawn: async () => {
        // Small delay to ensure non-zero duration
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, output: "done" };
      },
    };

    await executeAssignWorker({ task_id: "a" }, holder, config, controller.signal);

    const completed = holder.getBoard().completed();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.durationMs).toBeGreaterThan(0);
  });

  test("collects completed upstream results for task with dependencies", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r1 = board.addAll([
      { id: taskItemId("a"), description: "Task A" },
      { id: taskItemId("b"), description: "Task B", dependencies: [taskItemId("a")] },
    ]);
    if (!r1.ok) throw new Error("setup failed");
    const holder = createHolder(r1.value);

    // Track what spawn receives
    const captured: SpawnWorkerRequest[] = [];

    const config: OrchestratorConfig = {
      spawn: async (req) => {
        captured.push(req);
        return { ok: true, output: `result-${req.taskId}` };
      },
    };

    // Complete A first
    await executeAssignWorker({ task_id: "a" }, holder, config, controller.signal);
    expect(holder.getBoard().completed()).toHaveLength(1);

    // Now assign B — should receive upstream results from A
    await executeAssignWorker({ task_id: "b" }, holder, config, controller.signal);

    const bRequest = captured[1];
    expect(bRequest).toBeDefined();
    expect(bRequest?.upstreamResults).toBeDefined();
    expect(bRequest?.upstreamResults).toHaveLength(1);
    expect(bRequest?.upstreamResults?.[0]?.taskId).toBe(taskItemId("a"));
    expect(bRequest?.upstreamResults?.[0]?.output).toBe("result-a");
  });

  test("passes empty upstreamResults for task with no dependencies", async () => {
    const executeAssignWorker = createAssignWorkerExecutor();
    const board = createTaskBoard();
    const r = board.add({ id: taskItemId("a"), description: "Task A" });
    if (!r.ok) throw new Error("setup failed");
    const holder = createHolder(r.value);

    const captured: SpawnWorkerRequest[] = [];
    const config: OrchestratorConfig = {
      spawn: async (req) => {
        captured.push(req);
        return { ok: true, output: "done" };
      },
    };

    await executeAssignWorker({ task_id: "a" }, holder, config, controller.signal);

    const aRequest = captured[0];
    expect(aRequest).toBeDefined();
    expect(aRequest?.upstreamResults).toBeUndefined();
  });
});
