import { beforeEach, describe, expect, test } from "bun:test";
import type { TaskBoard } from "@koi/core";
import { taskItemId } from "@koi/core";
import { executeAssignWorker, resetWorkerCounter } from "./assign-worker-tool.js";
import { createTaskBoard } from "./board.js";
import type { BoardHolder } from "./orchestrate-tool.js";
import type { OrchestratorConfig } from "./types.js";

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

beforeEach(() => {
  resetWorkerCounter();
});

describe("executeAssignWorker", () => {
  test("assigns a ready task and spawns worker", async () => {
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
    const board = createTaskBoard();
    const r1 = board.addAll([
      { id: taskItemId("a"), description: "A" },
      { id: taskItemId("b"), description: "B" },
    ]);
    if (!r1.ok) throw new Error("setup failed");
    const r2 = r1.value.assign(taskItemId("a"), "worker-0" as import("@koi/core").AgentId);
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
    const holder = createHolder();
    const config: OrchestratorConfig = {
      spawn: async () => ({ ok: true, output: "done" }),
    };
    const result = await executeAssignWorker({}, holder, config, controller.signal);
    expect(result).toContain("task_id");
  });

  test("returns error when signal is aborted", async () => {
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
});
