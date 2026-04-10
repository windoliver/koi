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
import { isTerminalTaskStatus, isValidTaskKindName } from "@koi/core";
import { isUnsupportedLifecycle } from "./lifecycles/unsupported.js";
import type { OutputChunk } from "./output-stream.js";
import { createOutputStream, type OutputStreamConfig } from "./output-stream.js";
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
  readonly readOutput: (taskId: TaskItemId, fromOffset?: number) => Result<OutputDelta, KoiError>;
  /** All active (non-terminal) runtime tasks. */
  readonly active: () => readonly RuntimeTaskBase[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskRunner(config: TaskRunnerConfig): TaskRunner {
  const { board, store, registry, agentId, outputStreamConfig } = config;

  const activeTasks = new Map<TaskItemId, RuntimeTaskBase>();
  // Tracks exit codes for tasks that exited before activeTasks.set() completed
  // (race condition: fast-exiting processes can fire onExit during lifecycle.start())
  const pendingExits = new Map<TaskItemId, number>();
  // Tasks intentionally stopped — prevents stale pendingExits entries
  const stoppedTaskIds = new Set<TaskItemId>();
  // IDs the runner itself is currently writing to the board. When store.watch
  // fires a terminal event for an ID in this set, handleStoreEvent skips the
  // cleanup because the runner already triggered the transition itself. This
  // is defense in depth against double-stop (the "delete from activeTasks
  // before board.X" pattern already prevents most cases, but selfWriteIds
  // protects any future code path that forgets the ordering dance).
  const selfWriteIds = new Set<TaskItemId>();

  /**
   * Wrap a board mutation so the resulting store watch event is skipped by
   * handleStoreEvent. `try/finally` ensures the flag is cleared even on throw.
   */
  async function withSelfWrite<T>(taskId: TaskItemId, call: () => Promise<T>): Promise<T> {
    selfWriteIds.add(taskId);
    try {
      return await call();
    } finally {
      selfWriteIds.delete(taskId);
    }
  }

  // Subscribe to store events for external reconciliation
  const unsubscribe = store.watch(handleStoreEvent);

  function handleStoreEvent(event: TaskBoardStoreEvent): void {
    if (event.kind !== "put") return;

    const item = event.item;
    if (!isTerminalTaskStatus(item.status)) return;
    // Self-write skip: the runner caused this transition itself (via
    // withSelfWrite), so no external reconciliation is needed.
    if (selfWriteIds.has(item.id)) return;
    if (!activeTasks.has(item.id)) return;

    // Task was terminated externally — clean up runtime state
    const task = activeTasks.get(item.id);
    if (task === undefined) return;

    activeTasks.delete(item.id);

    // Fire-and-forget cleanup — errors are swallowed since the task is already terminal
    void registry
      .get(task.kind)
      ?.stop(task)
      .catch(() => {});
  }

  /**
   * Inject an onExit callback into task configs that support it.
   * When a process-based task exits naturally, the runner transitions the
   * board to completed (exit 0) or failed (non-zero).
   */
  function enrichConfigWithExitHandler(taskId: TaskItemId, taskConfig: unknown): unknown {
    if (typeof taskConfig !== "object" || taskConfig === null) {
      return {
        onExit: (code: number) => {
          void handleNaturalExit(taskId, code);
        },
      };
    }
    const cfg = taskConfig as Readonly<Record<string, unknown>>;
    const callerOnExit =
      typeof cfg.onExit === "function" ? (cfg.onExit as (code: number) => void) : undefined;
    return {
      ...cfg,
      onExit: (code: number) => {
        // Always run runner reconciliation, then chain the caller's callback
        void handleNaturalExit(taskId, code);
        callerOnExit?.(code);
      },
    };
  }

  /**
   * Async handler for natural process exits. Awaits board transitions and
   * handles failures so tasks don't remain stuck in_progress.
   */
  async function handleNaturalExit(taskId: TaskItemId, code: number): Promise<void> {
    // Ignore exits from intentionally stopped tasks
    if (stoppedTaskIds.has(taskId)) {
      stoppedTaskIds.delete(taskId);
      return;
    }
    const task = activeTasks.get(taskId);
    if (task === undefined) {
      // Task may not be registered yet (fast exit during lifecycle.start()).
      // Stash the exit code; start() will drain it after activeTasks.set().
      pendingExits.set(taskId, code);
      return;
    }
    activeTasks.delete(taskId);

    const bufferedChunks = task.output.read(0);
    const capturedOutput = bufferedChunks.map((c) => c.content).join("");
    const durationMs = Date.now() - task.startedAt;

    await withSelfWrite(taskId, async () => {
      try {
        if (code === 0) {
          const result = await board.completeOwnedTask(taskId, agentId, {
            taskId,
            output: capturedOutput || `Process exited with code 0`,
            durationMs,
            metadata: { exitCode: code },
          });
          // If completion fails (e.g. ownership changed), try to kill as fallback
          if (!result.ok) {
            await board.kill(taskId).catch(() => {});
          }
        } else {
          const result = await board.failOwnedTask(taskId, agentId, {
            code: "EXTERNAL",
            message: capturedOutput || `Process exited with code ${String(code)}`,
            retryable: false,
            context: { exitCode: code },
          });
          if (!result.ok) {
            await board.kill(taskId).catch(() => {});
          }
        }
      } catch {
        // Last resort: try to kill the task so it's not stuck in_progress
        await board.kill(taskId).catch(() => {});
      }
    });
  }

  const start = async (
    taskId: TaskItemId,
    kind: TaskKindName,
    taskConfig?: unknown,
  ): Promise<Result<RuntimeTaskBase, KoiError>> => {
    // Boundary validation: kind may come from untyped metadata.kind string.
    // VALIDATION = not a valid TaskKindName at all (boundary issue).
    // NOT_FOUND = valid kind but no lifecycle registered.
    if (!isValidTaskKindName(kind)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Unknown task kind: "${kind}"`,
          retryable: false,
        },
      };
    }

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

    // Reject unsupported kinds with a single atomic board operation.
    // killIfPending verifies pending status under the mutex, checks kind
    // match when metadata.kind exists, stores rejection reason, and kills.
    if (isUnsupportedLifecycle(lifecycle)) {
      const reason = `Task kind "${kind}" is not yet implemented`;
      const killResult = await withSelfWrite(taskId, () =>
        board.killIfPending(taskId, {
          expectedKind: kind,
          metadata: { rejectedKind: kind, rejectedReason: reason },
        }),
      );
      if (!killResult.ok) return killResult;

      return {
        ok: false,
        error: { code: "VALIDATION", message: reason, retryable: false },
      };
    }

    // Transition board first — validates ownership, single-in-progress, etc.
    const boardResult = await withSelfWrite(taskId, () => board.startTask(taskId, agentId));
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

      // Drain any exit that arrived before activeTasks.set() (fast-exit race)
      const pendingCode = pendingExits.get(taskId);
      if (pendingCode !== undefined) {
        pendingExits.delete(taskId);
        void handleNaturalExit(taskId, pendingCode);
      }

      return { ok: true, value: state };
    } catch (err: unknown) {
      // Lifecycle failed to start — fail the task on the board so it doesn't
      // remain stuck in_progress. Mirror the natural-exit fallback chain:
      // try failOwnedTask first; if that fails (e.g., store I/O error, version
      // conflict), fall back to board.kill() so the task lands in a terminal
      // state no matter what.
      const message = err instanceof Error ? err.message : String(err);
      await withSelfWrite(taskId, async () => {
        try {
          const failResult = await board.failOwnedTask(taskId, agentId, {
            code: "EXTERNAL",
            message: `Lifecycle start failed: ${message}`,
            retryable: false,
          });
          if (!failResult.ok) {
            await board.kill(taskId).catch(() => {});
          }
        } catch {
          // failOwnedTask itself threw — last-resort kill so the task is not
          // stranded in_progress with no runtime handle.
          await board.kill(taskId).catch(() => {});
        }
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

  const stop = async (taskId: TaskItemId): Promise<Result<void, KoiError>> => {
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

    // Mark as intentionally stopped so post-kill onExit doesn't stash a pendingExit
    stoppedTaskIds.add(taskId);
    // Remove from activeTasks BEFORE board transition to prevent the store
    // watcher from triggering a duplicate lifecycle.stop() call.
    activeTasks.delete(taskId);

    // Transition board — if this fails, the task is already removed from
    // active tracking (watcher won't double-stop) but we report the error.
    // withSelfWrite adds the belt-and-suspenders skip-set so any future
    // callers that forget to activeTasks.delete first are still safe.
    const boardResult = await withSelfWrite(taskId, () => board.killOwnedTask(taskId, agentId));

    // Clean up runtime state regardless of board result.
    // Wrap in try/catch so lifecycle failures don't reject the promise.
    const lifecycle = registry.get(task.kind);
    if (lifecycle !== undefined) {
      try {
        await lifecycle.stop(task);
      } catch {
        // Lifecycle cleanup failed — task is already removed from tracking
        // and board transition is done; swallow to honor the Result contract.
      }
    }

    if (!boardResult.ok) return boardResult;
    return { ok: true, value: undefined };
  };

  const get = (taskId: TaskItemId): RuntimeTaskBase | undefined => {
    return activeTasks.get(taskId);
  };

  const readOutput = (taskId: TaskItemId, fromOffset?: number): Result<OutputDelta, KoiError> => {
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
