import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentId, ManagedTaskBoard, TaskBoardStore, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import type { RuntimeTaskBase } from "./task-kinds.js";
import { createTaskRegistry, type TaskKindLifecycle } from "./task-registry.js";
import { createTaskRunner } from "./task-runner.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "agent_1" as AgentId;

function createMockStore(): TaskBoardStore {
  const listeners = new Set<
    (event: { readonly kind: string; readonly item?: unknown; readonly id?: TaskItemId }) => void
  >();
  return {
    get: mock(() => undefined),
    put: mock(() => {}),
    delete: mock(() => {}),
    list: mock(() => []),
    nextId: mock(() => taskItemId("task_1")),
    watch: (
      listener: (event: {
        readonly kind: string;
        readonly item?: unknown;
        readonly id?: TaskItemId;
      }) => void,
    ) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: mock(() => {}),
    [Symbol.asyncDispose]: mock(async () => {}),
    // Expose for testing
    _listeners: listeners,
  } as unknown as TaskBoardStore & { readonly _listeners: Set<(event: unknown) => void> };
}

function createMockBoard(store: TaskBoardStore): ManagedTaskBoard {
  return {
    snapshot: mock(() => ({
      get: () => undefined,
      ready: () => [],
      pending: () => [],
      blocked: () => [],
      inProgress: () => [],
      completed: () => [],
      failed: () => [],
      killed: () => [],
      unreachable: () => [],
      dependentsOf: () => [],
      all: () => [],
      size: () => 0,
      result: () => undefined,
      add: () => ({ ok: true, value: {} }),
      addAll: () => ({ ok: true, value: {} }),
      assign: () => ({ ok: true, value: {} }),
      complete: () => ({ ok: true, value: {} }),
      fail: () => ({ ok: true, value: {} }),
      kill: () => ({ ok: true, value: {} }),
      update: () => ({ ok: true, value: {} }),
    })),
    nextId: mock(async () => store.nextId() as TaskItemId),
    hasResultPersistence: mock(() => false),
    add: mock(async () => ({ ok: true as const, value: {} as never })),
    addAll: mock(async () => ({ ok: true as const, value: {} as never })),
    assign: mock(async () => ({ ok: true as const, value: {} as never })),
    startTask: mock(async () => ({ ok: true as const, value: {} as never })),
    complete: mock(async () => ({ ok: true as const, value: {} as never })),
    completeOwnedTask: mock(async () => ({ ok: true as const, value: {} as never })),
    fail: mock(async () => ({ ok: true as const, value: {} as never })),
    failOwnedTask: mock(async () => ({ ok: true as const, value: {} as never })),
    kill: mock(async () => ({ ok: true as const, value: {} as never })),
    killOwnedTask: mock(async () => ({ ok: true as const, value: {} as never })),
    update: mock(async () => ({ ok: true as const, value: {} as never })),
    updateOwned: mock(async () => ({ ok: true as const, value: {} as never })),
    [Symbol.asyncDispose]: mock(async () => {}),
  } as unknown as ManagedTaskBoard;
}

function createShellLifecycle(): TaskKindLifecycle {
  return {
    kind: "local_shell",
    start: mock(
      async (
        id: TaskItemId,
        output: TaskOutputStream,
        _config: unknown,
      ): Promise<RuntimeTaskBase> => {
        return {
          kind: "local_shell",
          taskId: id,
          cancel: mock(() => {}),
          output,
          startedAt: Date.now(),
          command: "echo test",
        } as unknown as RuntimeTaskBase;
      },
    ),
    stop: mock(async (_state: RuntimeTaskBase): Promise<void> => {}),
  };
}

import type { TaskOutputStream } from "./output-stream.js";

describe("createTaskRunner", () => {
  let store: ReturnType<typeof createMockStore>;
  let board: ManagedTaskBoard;
  let lifecycle: TaskKindLifecycle;

  beforeEach(() => {
    store = createMockStore();
    board = createMockBoard(store);
    lifecycle = createShellLifecycle();
  });

  test("start creates runtime task and calls board.startTask", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const taskId = taskItemId("task_1");
    const result = await runner.start(taskId, "local_shell", { command: "echo test" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe(taskId);
      expect(result.value.kind).toBe("local_shell");
    }
    expect(board.startTask).toHaveBeenCalledWith(taskId, AGENT_ID);
  });

  test("start with unregistered valid kind returns NOT_FOUND error", async () => {
    const registry = createTaskRegistry();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.start(taskItemId("task_1"), "dream");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("start with invalid kind string returns VALIDATION error", async () => {
    const registry = createTaskRegistry();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    // Simulate boundary input where metadata.kind is an arbitrary string
    const result = await runner.start(
      taskItemId("task_1"),
      "bogus_kind" as import("@koi/core").TaskKindName,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("bogus_kind");
    }
  });

  test("start returns error when board.startTask fails", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    (board.startTask as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: false,
      error: { code: "CONFLICT", message: "already in progress", retryable: false },
    }));

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.start(taskItemId("task_1"), "local_shell");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  test("stop calls lifecycle.stop and board.killOwnedTask", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const taskId = taskItemId("task_1");
    await runner.start(taskId, "local_shell");

    const result = await runner.stop(taskId);
    expect(result.ok).toBe(true);
    expect(lifecycle.stop).toHaveBeenCalled();
    expect(board.killOwnedTask).toHaveBeenCalledWith(taskId, AGENT_ID);
  });

  test("stop for unknown task returns NOT_FOUND", async () => {
    const registry = createTaskRegistry();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });

    const result = await runner.stop(taskItemId("task_999"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("get returns runtime state for active task", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const taskId = taskItemId("task_1");
    await runner.start(taskId, "local_shell");

    const task = runner.get(taskId);
    expect(task).toBeDefined();
    expect(task?.kind).toBe("local_shell");
  });

  test("get returns undefined for unknown task", () => {
    const registry = createTaskRegistry();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });

    expect(runner.get(taskItemId("task_999"))).toBeUndefined();
  });

  test("readOutput returns delta chunks", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const taskId = taskItemId("task_1");
    await runner.start(taskId, "local_shell");

    // Write to the task's output stream
    // biome-ignore lint/style/noNonNullAssertion: test — taskId was just created above
    const task = runner.get(taskId)!;
    task.output.write("hello ");
    task.output.write("world");

    const result = runner.readOutput(taskId, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chunks).toHaveLength(2);
      expect(result.value.chunks[0]?.content).toBe("hello ");
      expect(result.value.nextOffset).toBe(11);
    }
  });

  test("readOutput with offset returns delta only", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const taskId = taskItemId("task_1");
    await runner.start(taskId, "local_shell");

    // biome-ignore lint/style/noNonNullAssertion: test — taskId was just created above
    const task = runner.get(taskId)!;
    task.output.write("aaa");
    task.output.write("bbb");

    const result = runner.readOutput(taskId, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chunks).toHaveLength(1);
      expect(result.value.chunks[0]?.content).toBe("bbb");
    }
  });

  test("readOutput for unknown task returns NOT_FOUND", () => {
    const registry = createTaskRegistry();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });

    const result = runner.readOutput(taskItemId("task_999"));
    expect(result.ok).toBe(false);
  });

  test("active returns only running tasks", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    expect(runner.active()).toHaveLength(0);

    await runner.start(taskItemId("task_1"), "local_shell");
    expect(runner.active()).toHaveLength(1);

    await runner.start(taskItemId("task_2"), "local_shell");
    expect(runner.active()).toHaveLength(2);
  });

  test("dispose stops all active tasks", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");
    await runner.start(taskItemId("task_2"), "local_shell");

    await runner[Symbol.asyncDispose]();
    expect(runner.active()).toHaveLength(0);
    expect(lifecycle.stop).toHaveBeenCalledTimes(2);
  });

  test("store watch reconciles externally terminated tasks", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const taskId = taskItemId("task_1");
    await runner.start(taskId, "local_shell");

    expect(runner.active()).toHaveLength(1);

    // Simulate external terminal event from store
    const storeWithListeners = store as unknown as {
      readonly _listeners: Set<(event: unknown) => void>;
    };
    for (const listener of storeWithListeners._listeners) {
      listener({
        kind: "put",
        item: { id: taskId, status: "completed" },
      });
    }

    // Runner should have cleaned up
    expect(runner.active()).toHaveLength(0);
    expect(lifecycle.stop).toHaveBeenCalled();
  });
});
