/**
 * TaskRunner tests — real in-memory ManagedTaskBoard, mocked lifecycles.
 *
 * Previously this file used a fully mocked board with `{} as never` stub
 * return values, which meant the runner's race-condition code paths (fast-
 * exit drain, stop-after-natural-exit, cascading-failure → killed,
 * handleNaturalExit fallback chain, selfWriteIds skip-set) were never
 * exercised by any test. The mocks couldn't simulate real board state.
 *
 * This rewrite (review issue 9A) drops the mock board in favor of a real
 * `createManagedTaskBoard({ store: createMemoryTaskBoardStore() })`. Only
 * the LIFECYCLE is mocked — that gives us fine-grained control over start/
 * stop behavior without the mock-board fidelity loss.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentId, ManagedTaskBoard, TaskItemId, TaskKindName } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createManagedTaskBoard } from "./managed-board.js";
import { createMemoryTaskBoardStore } from "./memory-store.js";
import type { TaskOutputStream } from "./output-stream.js";
import type { RuntimeTaskBase } from "./task-kinds.js";
import { createTaskRegistry, type TaskKindLifecycle } from "./task-registry.js";
import { createTaskRunner } from "./task-runner.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const AGENT_ID = "agent_1" as AgentId;

function agentId(id: string): AgentId {
  return id as AgentId;
}

/** Build a real managed board with a fresh memory store and a pre-seeded task. */
async function setupBoard(): Promise<ManagedTaskBoard> {
  const store = createMemoryTaskBoardStore();
  return createManagedTaskBoard({ store });
}

/** Build a fake local_shell lifecycle whose start/stop can be overridden per test. */
function createShellLifecycle(overrides?: {
  readonly start?: TaskKindLifecycle["start"];
  readonly stop?: TaskKindLifecycle["stop"];
}): TaskKindLifecycle {
  const defaultStart: TaskKindLifecycle["start"] = async (
    id: TaskItemId,
    output: TaskOutputStream,
  ): Promise<RuntimeTaskBase> => {
    return {
      kind: "local_shell",
      taskId: id,
      cancel: mock(() => {}),
      output,
      startedAt: Date.now(),
    } as unknown as RuntimeTaskBase;
  };
  const defaultStop: TaskKindLifecycle["stop"] = async (): Promise<void> => {};
  return {
    kind: "local_shell",
    start: mock(overrides?.start ?? defaultStart),
    stop: mock(overrides?.stop ?? defaultStop),
  };
}

describe("createTaskRunner — basic behavior", () => {
  let board: ManagedTaskBoard;
  let lifecycle: TaskKindLifecycle;

  beforeEach(async () => {
    board = await setupBoard();
    lifecycle = createShellLifecycle();
    // Seed a task to run against (not pre-assigned)
    await board.add({ id: taskItemId("task_1"), description: "test task" });
  });

  test("start creates runtime task and transitions board to in_progress", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore(); // for runner's watch subscription
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.start(taskItemId("task_1"), "local_shell");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe(taskItemId("task_1"));
      expect(result.value.kind).toBe("local_shell");
    }
    // Board state reflects the transition
    expect(board.snapshot().get(taskItemId("task_1"))?.status).toBe("in_progress");
  });

  test("start with unregistered valid kind returns NOT_FOUND error", async () => {
    const registry = createTaskRegistry();
    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.start(taskItemId("task_1"), "dream");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("start with invalid kind string returns VALIDATION error", async () => {
    const registry = createTaskRegistry();
    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.start(taskItemId("task_1"), "bogus_kind" as TaskKindName);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("bogus_kind");
    }
  });

  test("stop kills the task and calls lifecycle.stop exactly once", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");

    const result = await runner.stop(taskItemId("task_1"));
    expect(result.ok).toBe(true);
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
    expect(board.snapshot().get(taskItemId("task_1"))?.status).toBe("killed");
  });

  test("stop for unknown task returns NOT_FOUND", async () => {
    const registry = createTaskRegistry();
    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.stop(taskItemId("task_999"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("get / active return runtime state for active tasks", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    expect(runner.active()).toHaveLength(0);

    await runner.start(taskItemId("task_1"), "local_shell");
    expect(runner.active()).toHaveLength(1);
    expect(runner.get(taskItemId("task_1"))?.kind).toBe("local_shell");
    expect(runner.get(taskItemId("task_999"))).toBeUndefined();
  });

  test("readOutput returns delta chunks from the task's output stream", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");

    const task = runner.get(taskItemId("task_1"));
    expect(task).toBeDefined();
    if (task === undefined) return;
    task.output.write("hello ");
    task.output.write("world");

    const delta0 = runner.readOutput(taskItemId("task_1"), 0);
    expect(delta0.ok).toBe(true);
    if (delta0.ok) {
      expect(delta0.value.chunks).toHaveLength(2);
      expect(delta0.value.nextOffset).toBe(11);
    }

    const delta6 = runner.readOutput(taskItemId("task_1"), 6);
    expect(delta6.ok).toBe(true);
    if (delta6.ok) {
      expect(delta6.value.chunks).toHaveLength(1);
      expect(delta6.value.chunks[0]?.content).toBe("world");
    }
  });

  test("readOutput for unknown task returns NOT_FOUND", async () => {
    const registry = createTaskRegistry();
    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = runner.readOutput(taskItemId("task_999"));
    expect(result.ok).toBe(false);
  });

  test("dispose stops every active task", async () => {
    const registry = createTaskRegistry();
    registry.register(lifecycle);
    await board.add({ id: taskItemId("task_2"), description: "second" });

    // Manually raise maxInProgressPerOwner — setupBoard defaults to undefined
    // (unlimited), and the default config path also allows two at a time.
    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");
    // Complete task_1 via the runner's stop so we can start task_2
    await runner.stop(taskItemId("task_1"));
    // task_1 is now killed — re-seed task_1 is not needed; start task_2
    await runner.start(taskItemId("task_2"), "local_shell");
    expect(runner.active()).toHaveLength(1);
    await runner[Symbol.asyncDispose]();
    expect(runner.active()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Race conditions (#1557 review fix 9A)
// ---------------------------------------------------------------------------
//
// These tests exercise the explicit-comment-flagged race paths in task-runner.ts
// that had zero coverage in the old mock-based test file:
//
//   - pendingExits drain (fast-exit during lifecycle.start)
//   - stoppedTaskIds (post-stop natural-exit suppression)
//   - cascading failure in start() catch (Issue 8A)
//   - handleNaturalExit → completeOwnedTask ok:false → kill fallback
//   - handleNaturalExit outer catch → kill fallback
//   - selfWriteIds skip-set prevents double-stop (Issue 2A)

describe("createTaskRunner — race conditions", () => {
  test("fast-exit drain: process exits before activeTasks.set()", async () => {
    // lifecycle.start captures the onExit callback and fires it synchronously
    // BEFORE returning the RuntimeTaskBase. handleNaturalExit runs, sees
    // activeTasks.has(taskId) === false, and stashes the exit code in
    // pendingExits. After start() returns and sets activeTasks, the runner
    // drains the pending exit and reconciles the board.
    const board = await setupBoard();
    await board.add({ id: taskItemId("task_1"), description: "fast-exit" });

    const lifecycle = createShellLifecycle({
      start: async (id, output, config) => {
        // Synchronously invoke the injected onExit BEFORE returning the task state.
        const cfg = config as { readonly onExit?: (code: number) => void };
        cfg.onExit?.(0);
        output.write("done");
        return {
          kind: "local_shell",
          taskId: id,
          cancel: mock(() => {}),
          output,
          startedAt: Date.now(),
        } as unknown as RuntimeTaskBase;
      },
    });
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.start(taskItemId("task_1"), "local_shell");
    expect(result.ok).toBe(true);

    // Give the microtask queue time to drain the pending exit
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Task should have been reconciled to completed via the drain path
    expect(board.snapshot().get(taskItemId("task_1"))?.status).toBe("completed");
    // And removed from active tracking
    expect(runner.get(taskItemId("task_1"))).toBeUndefined();
  });

  test("stop after natural exit is a no-op, not a double-stop", async () => {
    const board = await setupBoard();
    await board.add({ id: taskItemId("task_1"), description: "natural exit then stop" });

    // let justified: captured by the fake lifecycle for use below
    let capturedOnExit: ((code: number) => void) | undefined;
    const lifecycle = createShellLifecycle({
      start: async (id, output, config) => {
        const cfg = config as { readonly onExit?: (code: number) => void };
        capturedOnExit = cfg.onExit;
        return {
          kind: "local_shell",
          taskId: id,
          cancel: mock(() => {}),
          output,
          startedAt: Date.now(),
        } as unknown as RuntimeTaskBase;
      },
    });
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");

    // Fire natural exit
    capturedOnExit?.(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(board.snapshot().get(taskItemId("task_1"))?.status).toBe("completed");
    expect(lifecycle.stop).not.toHaveBeenCalled(); // handleNaturalExit doesn't call stop

    // Now a late stop() call must NOT double-terminate
    const stopResult = await runner.stop(taskItemId("task_1"));
    expect(stopResult.ok).toBe(false);
    if (!stopResult.ok) expect(stopResult.error.code).toBe("NOT_FOUND");
  });

  test("cascading failure: lifecycle.start rejects → failOwnedTask, task is terminal", async () => {
    const board = await setupBoard();
    await board.add({ id: taskItemId("task_1"), description: "will reject" });

    const lifecycle = createShellLifecycle({
      start: async () => {
        throw new Error("lifecycle boom");
      },
    });
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.start(taskItemId("task_1"), "local_shell");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("lifecycle boom");

    // Task must NOT be left in_progress — either failed or killed is acceptable.
    const status = board.snapshot().get(taskItemId("task_1"))?.status;
    expect(status === "failed" || status === "killed").toBe(true);
  });

  test("cascading failure: start rejects AND failOwnedTask rejects → kill fallback", async () => {
    // Build a board whose failOwnedTask is forced to fail. We patch the
    // real managed board to simulate the cascade.
    const board = await setupBoard();
    await board.add({ id: taskItemId("task_1"), description: "cascade" });

    // Replace failOwnedTask with a rejecter — the runner must fall back to kill
    const originalFailOwned = board.failOwnedTask.bind(board);
    Object.assign(board, {
      failOwnedTask: async () => ({
        ok: false as const,
        error: {
          code: "EXTERNAL" as const,
          message: "store I/O error",
          retryable: false,
        },
      }),
    });
    void originalFailOwned; // silence unused

    const lifecycle = createShellLifecycle({
      start: async () => {
        throw new Error("lifecycle boom");
      },
    });
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    const result = await runner.start(taskItemId("task_1"), "local_shell");
    expect(result.ok).toBe(false);
    // Task must still end up terminal — the kill fallback ran
    expect(board.snapshot().get(taskItemId("task_1"))?.status).toBe("killed");
  });

  test("handleNaturalExit: completeOwnedTask ok:false → kill fallback", async () => {
    const board = await setupBoard();
    await board.add({ id: taskItemId("task_1"), description: "natural exit with bad complete" });

    // Patch completeOwnedTask to return ok:false
    Object.assign(board, {
      completeOwnedTask: async () => ({
        ok: false as const,
        error: {
          code: "CONFLICT" as const,
          message: "simulated ownership conflict",
          retryable: false,
        },
      }),
    });

    // let justified: captured onExit from the fake lifecycle
    let capturedOnExit: ((code: number) => void) | undefined;
    const lifecycle = createShellLifecycle({
      start: async (id, output, config) => {
        const cfg = config as { readonly onExit?: (code: number) => void };
        capturedOnExit = cfg.onExit;
        return {
          kind: "local_shell",
          taskId: id,
          cancel: mock(() => {}),
          output,
          startedAt: Date.now(),
        } as unknown as RuntimeTaskBase;
      },
    });
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");

    capturedOnExit?.(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Task landed killed via the fallback, not stuck in_progress
    expect(board.snapshot().get(taskItemId("task_1"))?.status).toBe("killed");
  });

  test("handleNaturalExit: completeOwnedTask throws → outer catch kill fallback", async () => {
    const board = await setupBoard();
    await board.add({ id: taskItemId("task_1"), description: "natural exit with throw" });

    Object.assign(board, {
      completeOwnedTask: async () => {
        throw new Error("store threw");
      },
    });

    // let justified: captured onExit from the fake lifecycle
    let capturedOnExit: ((code: number) => void) | undefined;
    const lifecycle = createShellLifecycle({
      start: async (id, output, config) => {
        const cfg = config as { readonly onExit?: (code: number) => void };
        capturedOnExit = cfg.onExit;
        return {
          kind: "local_shell",
          taskId: id,
          cancel: mock(() => {}),
          output,
          startedAt: Date.now(),
        } as unknown as RuntimeTaskBase;
      },
    });
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const store = createMemoryTaskBoardStore();
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");

    capturedOnExit?.(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(board.snapshot().get(taskItemId("task_1"))?.status).toBe("killed");
  });

  test("selfWriteIds skip-set: natural exit does not trigger double-stop via watch", async () => {
    // The store watch echoes every put. Without the skip-set, the runner's
    // own completeOwnedTask write would echo back to handleStoreEvent and
    // call lifecycle.stop a second time. The skip-set prevents this.
    const store = createMemoryTaskBoardStore();
    const board = await createManagedTaskBoard({ store });
    await board.add({ id: taskItemId("task_1"), description: "self-write" });

    // let justified: captured onExit
    let capturedOnExit: ((code: number) => void) | undefined;
    const lifecycle = createShellLifecycle({
      start: async (id, output, config) => {
        const cfg = config as { readonly onExit?: (code: number) => void };
        capturedOnExit = cfg.onExit;
        return {
          kind: "local_shell",
          taskId: id,
          cancel: mock(() => {}),
          output,
          startedAt: Date.now(),
        } as unknown as RuntimeTaskBase;
      },
    });
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    // Share the same store with the runner so the watch fires on self-writes
    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");

    capturedOnExit?.(0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // lifecycle.stop must NOT have been called — the natural-exit path does
    // not call stop (handleNaturalExit just transitions the board), and the
    // watch echo is suppressed by the selfWriteIds skip-set.
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(board.snapshot().get(taskItemId("task_1"))?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// External reconciliation (keeps the old store-watch test, now with real store)
// ---------------------------------------------------------------------------

describe("createTaskRunner — external reconciliation", () => {
  test("external terminal transition cleans up runtime state via watch", async () => {
    const store = createMemoryTaskBoardStore();
    const board = await createManagedTaskBoard({ store });
    await board.add({ id: taskItemId("task_1"), description: "externally terminated" });

    const lifecycle = createShellLifecycle();
    const registry = createTaskRegistry();
    registry.register(lifecycle);

    const runner = createTaskRunner({ board, store, registry, agentId: AGENT_ID });
    await runner.start(taskItemId("task_1"), "local_shell");
    expect(runner.active()).toHaveLength(1);

    // Externally kill the task (not via the runner)
    await board.kill(taskItemId("task_1"));
    // Watch event fires synchronously via notifier.notify; no delay needed
    // but allow the microtask queue to settle just in case.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Runner cleaned up
    expect(runner.active()).toHaveLength(0);
    expect(lifecycle.stop).toHaveBeenCalled();
  });
});

// Reference unused agentId helper to silence lint
void agentId;
