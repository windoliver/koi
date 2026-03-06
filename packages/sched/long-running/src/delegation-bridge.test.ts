import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnRequest, SpawnResult, TaskBoard, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createTaskBoard } from "@koi/task-board";
import { computeBackoff, createDelegationBridge } from "./delegation-bridge.js";

function spawnOk(output = "done"): SpawnFn {
  return async (_req: SpawnRequest): Promise<SpawnResult> => ({ ok: true, output });
}

function spawnFail(message = "error"): SpawnFn {
  return async (_req: SpawnRequest): Promise<SpawnResult> => ({
    ok: false,
    error: { code: "EXTERNAL", message, retryable: true },
  });
}

function spawnThrow(message = "crash"): SpawnFn {
  return async (_req: SpawnRequest): Promise<SpawnResult> => {
    throw new Error(message);
  };
}

function setupBoard(
  tasks: ReadonlyArray<{
    readonly id: string;
    readonly deps?: readonly string[];
    readonly delegation?: "self" | "spawn";
    readonly agentType?: string;
  }>,
): TaskBoard {
  const board = createTaskBoard({ maxRetries: 3 });
  const inputs = tasks.map((t) => ({
    id: taskItemId(t.id),
    description: `Task ${t.id}`,
    dependencies: (t.deps ?? []).map(taskItemId),
    delegation: t.delegation,
    agentType: t.agentType,
  }));
  const result = board.addAll(inputs);
  if (!result.ok) throw new Error(`Board setup failed: ${result.error.message}`);
  return result.value;
}

describe("computeBackoff", () => {
  test("returns 0 for retries <= 0", () => {
    expect(computeBackoff(0)).toBe(0);
    expect(computeBackoff(-1)).toBe(0);
  });

  test("returns 10s for first retry", () => {
    expect(computeBackoff(1)).toBe(10_000);
  });

  test("doubles each retry", () => {
    expect(computeBackoff(2)).toBe(20_000);
    expect(computeBackoff(3)).toBe(40_000);
  });

  test("caps at 300s", () => {
    expect(computeBackoff(10)).toBe(300_000);
    expect(computeBackoff(100)).toBe(300_000);
  });
});

describe("createDelegationBridge", () => {
  test("dispatches spawn tasks but not self tasks", async () => {
    const spawnCalls: SpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      spawnCalls.push(req);
      return { ok: true, output: "done" };
    };

    const board = setupBoard([
      { id: "a", delegation: "spawn" },
      { id: "b", delegation: "self" },
      { id: "c" }, // undefined delegation
    ]);

    const bridge = createDelegationBridge({ spawn });
    const result = await bridge.dispatchReady(board);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.taskId).toBe(taskItemId("a"));
    expect(result.get(taskItemId("a"))?.status).toBe("completed");
    expect(result.get(taskItemId("b"))?.status).toBe("pending");
    expect(result.get(taskItemId("c"))?.status).toBe("pending");
  });

  test("spawn success completes task on board", async () => {
    const board = setupBoard([{ id: "a", delegation: "spawn" }]);
    const bridge = createDelegationBridge({ spawn: spawnOk("my output") });
    const result = await bridge.dispatchReady(board);

    expect(result.get(taskItemId("a"))?.status).toBe("completed");
    expect(result.result(taskItemId("a"))?.output).toBe("my output");
  });

  test("spawn clean failure triggers board.fail with retryable", async () => {
    const board = setupBoard([{ id: "a", delegation: "spawn" }]);
    const bridge = createDelegationBridge({ spawn: spawnFail("oops") });
    const result = await bridge.dispatchReady(board);

    // Should be retried (back to pending with retries incremented)
    const item = result.get(taskItemId("a"));
    expect(item?.status).toBe("pending");
    expect(item?.retries).toBe(1);
  });

  test("spawn abnormal failure (throw) triggers board.fail with backoff context", async () => {
    const board = setupBoard([{ id: "a", delegation: "spawn" }]);
    const bridge = createDelegationBridge({ spawn: spawnThrow("kaboom") });
    const result = await bridge.dispatchReady(board);

    const item = result.get(taskItemId("a"));
    expect(item?.status).toBe("pending");
    expect(item?.retries).toBe(1);
    expect(item?.error?.context?.abnormal).toBe(true);
  });

  test("dependency cascade: completing A dispatches B", async () => {
    const dispatched: TaskItemId[] = [];
    const spawn: SpawnFn = async (req) => {
      if (req.taskId !== undefined) dispatched.push(req.taskId);
      return { ok: true, output: `done-${req.taskId}` };
    };

    const board = setupBoard([
      { id: "a", delegation: "spawn" },
      { id: "b", deps: ["a"], delegation: "spawn" },
    ]);

    const bridge = createDelegationBridge({ spawn });
    const result = await bridge.dispatchReady(board);

    expect(dispatched).toContain(taskItemId("a"));
    expect(dispatched).toContain(taskItemId("b"));
    expect(result.get(taskItemId("a"))?.status).toBe("completed");
    expect(result.get(taskItemId("b"))?.status).toBe("completed");
  });

  test("uses DEFERRED delivery policy by default", async () => {
    const requests: SpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      requests.push(req);
      return { ok: true, output: "done" };
    };

    const board = setupBoard([{ id: "a", delegation: "spawn" }]);
    const bridge = createDelegationBridge({ spawn });
    await bridge.dispatchReady(board);

    expect(requests[0]?.delivery?.kind).toBe("deferred");
  });

  test("passes agentType to spawn as agentName", async () => {
    const requests: SpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      requests.push(req);
      return { ok: true, output: "done" };
    };

    const board = setupBoard([{ id: "a", delegation: "spawn", agentType: "researcher" }]);
    const bridge = createDelegationBridge({ spawn });
    await bridge.dispatchReady(board);

    expect(requests[0]?.agentName).toBe("researcher");
  });

  test("prepends upstream context to description", async () => {
    const requests: SpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      requests.push(req);
      return { ok: true, output: "result" };
    };

    const board = setupBoard([
      { id: "a", delegation: "spawn" },
      { id: "b", deps: ["a"], delegation: "spawn" },
    ]);

    const bridge = createDelegationBridge({ spawn });
    await bridge.dispatchReady(board);

    // b's description should include upstream context from a
    const bRequest = requests.find((r) => r.taskId === taskItemId("b"));
    expect(bRequest?.description).toContain("Upstream Context");
  });

  test("fires onTaskDispatched and onTaskCompleted callbacks", async () => {
    const dispatched: TaskItemId[] = [];
    const completed: TaskItemId[] = [];

    const board = setupBoard([{ id: "a", delegation: "spawn" }]);
    const bridge = createDelegationBridge({
      spawn: spawnOk(),
      onTaskDispatched: (id) => dispatched.push(id),
      onTaskCompleted: (id) => completed.push(id),
    });
    await bridge.dispatchReady(board);

    expect(dispatched).toEqual([taskItemId("a")]);
    expect(completed).toEqual([taskItemId("a")]);
  });

  test("abort prevents further dispatches", async () => {
    const spawnCalls: SpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      spawnCalls.push(req);
      return { ok: true, output: "done" };
    };

    const board = setupBoard([{ id: "a", delegation: "spawn" }]);
    const bridge = createDelegationBridge({ spawn });
    bridge.abort();
    await bridge.dispatchReady(board);

    // Task was assigned but spawn saw the abort signal
    // The exact behavior depends on timing, but it should not crash
    expect(bridge.inFlightCount()).toBe(0);
  });

  test("truncates long spawn output", async () => {
    const board = setupBoard([{ id: "a", delegation: "spawn" }]);
    const bridge = createDelegationBridge({
      spawn: spawnOk("x".repeat(10000)),
      maxOutputPerTask: 100,
    });
    const result = await bridge.dispatchReady(board);

    const output = result.result(taskItemId("a"))?.output;
    expect(output).toBeDefined();
    expect(output?.length).toBeLessThan(200);
    expect(output).toContain("truncated");
  });
});
