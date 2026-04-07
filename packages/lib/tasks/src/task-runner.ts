/**
 * TaskRunner — orchestrates starting, stopping, and reading output from runtime tasks.
 *
 * Bridges the TaskRegistry (lifecycle implementations) with the ManagedTaskBoard
 * (persistent state). Subscribes to the TaskBoardStore watch events to reconcile
 * runtime state when tasks are terminated externally.
 */

import type {
  AgentId,
  KoiError,
  ManagedTaskBoard,
  Result,
  TaskBoardStore,
  TaskBoardStoreEvent,
  TaskItemId,
  TaskKindName,
} from "@koi/core";
import { isTerminalTaskStatus } from "@koi/core";
import { type OutputStreamConfig, createOutputStream } from "./output-stream.js";
import type { OutputChunk } from "./output-stream.js";
import type { RuntimeTaskBase } from "./task-kinds.js";
import type { TaskRegistry } from "./task-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskRunnerConfig {
  readonly board: ManagedTaskBoard;
  /** Store for watch() subscription — reconciles external terminal events. */
  readonly store: TaskBoardStore;
  readonly registry: TaskRegistry;
  readonly agentId: AgentId;
  readonly outputStreamConfig?: OutputStreamConfig | undefined;
}

/** Delta read result from a task's output stream. */
export interface OutputDelta {
  readonly chunks: readonly OutputChunk[];
  readonly nextOffset: number;
}

export interface TaskRunner extends AsyncDisposable {
  /** Start a task — looks up lifecycle by kind, creates runtime state, transitions board. */
  readonly start: (
    taskId: TaskItemId,
    kind: TaskKindName,
    config?: unknown,
  ) => Promise<Result<RuntimeTaskBase, KoiError>>;
  /** Stop a running task — calls lifecycle.stop, transitions board to killed. */
  readonly stop: (taskId: TaskItemId) => Promise<Result<void, KoiError>>;
  /** Get runtime state for a task. */
  readonly get: (taskId: TaskItemId) => RuntimeTaskBase | undefined;
  /** Read output with delta offset. */
  readonly readOutput: (
    taskId: TaskItemId,
    fromOffset?: number,
  ) => Result<OutputDelta, KoiError>;
  /** All active (non-terminal) runtime tasks. */
  readonly active: () => readonly RuntimeTaskBase[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskRunner(config: TaskRunnerConfig): TaskRunner {
  const { board, store, registry, agentId, outputStreamConfig } = config;

  const activeTasks = new Map<TaskItemId, RuntimeTaskBase>();

  // Subscribe to store events for external reconciliation
  const unsubscribe = store.watch(handleStoreEvent);

  function handleStoreEvent(event: TaskBoardStoreEvent): void {
    if (event.kind !== "put") return;

    const item = event.item;
    if (!isTerminalTaskStatus(item.status)) return;
    if (!activeTasks.has(item.id)) return;

    // Task was terminated externally — clean up runtime state
    const task = activeTasks.get(item.id);
    if (task === undefined) return;

    activeTasks.delete(item.id);

    // Fire-and-forget cleanup — errors are swallowed since the task is already terminal
    void registry.get(task.kind)?.stop(task).catch(() => {});
  }

  const start = async (
    taskId: TaskItemId,
    kind: TaskKindName,
    taskConfig?: unknown,
  ): Promise<Result<RuntimeTaskBase, KoiError>> => {
    const lifecycle = registry.get(kind);
    if (lifecycle === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `No lifecycle registered for task kind "${kind}"`,
          retryable: false,
        },
      };
    }

    // Transition board first — validates ownership, single-in-progress, etc.
    const boardResult = await board.startTask(taskId, agentId);
    if (!boardResult.ok) return boardResult;

    // Create output stream and start the lifecycle.
    // Wrap in try/catch: if lifecycle.start() rejects, fail the task on the board
    // so it doesn't remain stuck in_progress with no runtime handle.
    const output = createOutputStream(outputStreamConfig);
    try {
      const state = await lifecycle.start(taskId, output, taskConfig);
      activeTasks.set(taskId, state);
      return { ok: true, value: state };
    } catch (err: unknown) {
      // Lifecycle failed to start — fail the task on the board
      const message = err instanceof Error ? err.message : String(err);
      await board.failOwnedTask(taskId, agentId, {
        code: "EXTERNAL",
        message: `Lifecycle start failed: ${message}`,
        retryable: false,
      });
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Failed to start task "${taskId}": ${message}`,
          retryable: false,
        },
      };
    }
  };

  const stop = async (
    taskId: TaskItemId,
  ): Promise<Result<void, KoiError>> => {
    const task = activeTasks.get(taskId);
    if (task === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `No active runtime task with id "${taskId}"`,
          retryable: false,
        },
      };
    }

    // Transition board first — if this fails (e.g. ownership changed),
    // we keep the runtime state so the caller can retry or read output.
    const boardResult = await board.killOwnedTask(taskId, agentId);
    if (!boardResult.ok) return boardResult;

    // Board succeeded — now clean up runtime state
    const lifecycle = registry.get(task.kind);
    if (lifecycle !== undefined) {
      await lifecycle.stop(task);
    }
    activeTasks.delete(taskId);

    return { ok: true, value: undefined };
  };

  const get = (taskId: TaskItemId): RuntimeTaskBase | undefined => {
    return activeTasks.get(taskId);
  };

  const readOutput = (
    taskId: TaskItemId,
    fromOffset?: number,
  ): Result<OutputDelta, KoiError> => {
    const task = activeTasks.get(taskId);
    if (task === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `No active runtime task with id "${taskId}"`,
          retryable: false,
        },
      };
    }

    const offset = fromOffset ?? 0;
    const chunks = task.output.read(offset);
    const nextOffset = task.output.length();

    return { ok: true, value: { chunks, nextOffset } };
  };

  const active = (): readonly RuntimeTaskBase[] => {
    return [...activeTasks.values()];
  };

  const dispose = async (): Promise<void> => {
    unsubscribe();

    // Stop all active tasks
    const tasks = [...activeTasks.values()];
    for (const task of tasks) {
      const lifecycle = registry.get(task.kind);
      if (lifecycle !== undefined) {
        await lifecycle.stop(task);
      }
      activeTasks.delete(task.taskId);
    }
  };

  return {
    start,
    stop,
    get,
    readOutput,
    active,
    [Symbol.asyncDispose]: dispose,
  };
}
