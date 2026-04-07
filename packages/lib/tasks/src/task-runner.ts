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

  /**
   * Inject an onExit callback into task configs that support it.
   * When a process-based task exits naturally, the runner transitions the
   * board to completed (exit 0) or failed (non-zero).
   */
  function enrichConfigWithExitHandler(taskId: TaskItemId, taskConfig: unknown): unknown {
    if (typeof taskConfig !== "object" || taskConfig === null) return taskConfig;
    const cfg = taskConfig as Readonly<Record<string, unknown>>;
    // Only inject if the config doesn't already have an onExit
    if (cfg.onExit !== undefined) return taskConfig;
    return {
      ...cfg,
      onExit: (code: number) => {
        // Remove from active tasks first to prevent duplicate stop from watcher
        const task = activeTasks.get(taskId);
        if (task === undefined) return;
        activeTasks.delete(taskId);

        if (code === 0) {
          void board.completeOwnedTask(taskId, agentId, {
            taskId,
            output: `Process exited with code ${String(code)}`,
            durationMs: Date.now() - task.startedAt,
          });
        } else {
          void board.failOwnedTask(taskId, agentId, {
            code: "EXTERNAL",
            message: `Process exited with code ${String(code)}`,
            retryable: false,
          });
        }
      },
    };
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

    // Inject an onExit callback so the runner can transition the board when
    // a process-based task exits naturally (without explicit stop()).
    const enrichedConfig = enrichConfigWithExitHandler(taskId, taskConfig);

    try {
      const state = await lifecycle.start(taskId, output, enrichedConfig);
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

    // Remove from activeTasks BEFORE board transition to prevent the store
    // watcher from triggering a duplicate lifecycle.stop() call.
    activeTasks.delete(taskId);

    // Transition board — if this fails, the task is already removed from
    // active tracking (watcher won't double-stop) but we report the error.
    const boardResult = await board.killOwnedTask(taskId, agentId);

    // Clean up runtime state regardless of board result
    const lifecycle = registry.get(task.kind);
    if (lifecycle !== undefined) {
      await lifecycle.stop(task);
    }

    if (!boardResult.ok) return boardResult;
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
