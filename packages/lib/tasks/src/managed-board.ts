/**
 * ManagedTaskBoard — bridges TaskBoard (immutable logic) with TaskBoardStore (persistence).
 *
 * Loads initial state from the store, applies board mutations with validation,
 * and auto-persists changed tasks back to the store using version-based diff.
 *
 * **Single-writer**: mutations are serialized within this instance via an async
 * mutex, so concurrent calls from the same process are safe. Multiple
 * ManagedTaskBoard instances sharing the same store are NOT safe — use an
 * external lock or a store with atomic conditional writes for multi-writer.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentId,
  KoiError,
  ManagedTaskBoard,
  Result,
  Task,
  TaskBoard,
  TaskBoardConfig,
  TaskBoardStore,
  TaskInput,
  TaskItemId,
  TaskPatch,
  TaskResult,
} from "@koi/core";
import { createTaskBoard } from "@koi/task-board";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManagedTaskBoardConfig {
  readonly store: TaskBoardStore;
  readonly boardConfig?: TaskBoardConfig | undefined;
  /**
   * Directory for persisting TaskResult JSON files.
   * If omitted, completed task results are in-memory only and
   * will not survive process restart.
   */
  readonly resultsDir?: string | undefined;
}

// ManagedTaskBoard interface is defined in @koi/core so L2 packages can
// depend on it without importing the L2 implementation (@koi/tasks).
export type { ManagedTaskBoard } from "@koi/core";

// ---------------------------------------------------------------------------
// Result persistence helpers
// ---------------------------------------------------------------------------

const RESULT_FILE_REGEX = /\.result\.json$/;

async function loadResultsFromDir(dir: string): Promise<readonly TaskResult[]> {
  try {
    const entries = await readdir(dir);
    const results: TaskResult[] = [];
    for (const entry of entries) {
      if (!RESULT_FILE_REGEX.test(entry)) continue;
      try {
        const file = Bun.file(join(dir, entry));
        results.push((await file.json()) as TaskResult);
      } catch {
        // Skip corrupted result files
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function persistResult(dir: string, result: TaskResult): Promise<void> {
  await Bun.write(join(dir, `${result.taskId}.result.json`), JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist tasks that changed between old and new board states.
 * Uses the version field for efficient diff — only writes tasks with incremented version.
 *
 * Writes sequentially so that a failure mid-batch leaves a known prefix
 * of tasks committed. On failure, rolls back already-written tasks to their
 * old versions so the store stays consistent with the pre-mutation board.
 */
async function persistBoardDiff(
  store: TaskBoardStore,
  oldBoard: TaskBoard,
  newBoard: TaskBoard,
): Promise<void> {
  const changed: Task[] = [];
  for (const task of newBoard.all()) {
    const old = oldBoard.get(task.id);
    if (old === undefined || old.version < task.version) {
      changed.push(task);
    }
  }

  const written: Task[] = [];
  try {
    for (const task of changed) {
      await store.put(task);
      written.push(task);
    }
  } catch (err: unknown) {
    // Rollback: restore already-written tasks to their old versions.
    // Old tasks have a lower version, so we need to delete + re-put
    // (the stale-write guard would reject a lower-version put).
    for (const task of written) {
      const old = oldBoard.get(task.id);
      try {
        if (old !== undefined) {
          await store.delete(task.id);
          await store.put(old);
        } else {
          await store.delete(task.id);
        }
      } catch {
        // Best-effort rollback — if this fails too, the store is inconsistent
        // but we surface the original error, not the rollback error.
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ManagedTaskBoard that bridges an immutable TaskBoard with a TaskBoardStore.
 *
 * Loads initial state from the store (and resultsDir if provided).
 * Each mutation validates through the board's invariants, then persists
 * changed tasks back to the store. Mutations are serialized to prevent
 * concurrent-call races.
 */
export async function createManagedTaskBoard(
  config: ManagedTaskBoardConfig,
): Promise<ManagedTaskBoard> {
  const { store, boardConfig, resultsDir } = config;

  // Load initial state from store
  const items = await store.list();

  // Load persisted results if resultsDir is provided.
  // Only include results whose task is actually completed in the store
  // to avoid orphaned result files from failed persistence.
  let initialResults: readonly TaskResult[] = [];
  if (resultsDir !== undefined) {
    await mkdir(resultsDir, { recursive: true });
    const allResults = await loadResultsFromDir(resultsDir);
    const completedIds = new Set(
      items.filter((t) => t.status === "completed").map((t) => t.id),
    );
    initialResults = allResults.filter((r) => completedIds.has(r.taskId));
  }

  // let justified: board is mutable state managed by the managed board
  let board = createTaskBoard(boardConfig, { items, results: initialResults });

  // Async mutex: mutations queue behind the previous one to prevent
  // two callers from deriving from the same base board concurrently.
  let pending: Promise<unknown> = Promise.resolve();

  /**
   * Apply a board mutation, serialize with the mutex, and persist changed tasks.
   *
   * `beforePersist` runs BEFORE task state is written to the store (e.g., persist
   * result files). If it fails, the task state is never advanced, so retries work.
   */
  async function applyMutation(
    mutate: (b: TaskBoard) => Result<TaskBoard, KoiError>,
    beforePersist?: () => Promise<void>,
  ): Promise<Result<TaskBoard, KoiError>> {
    // Chain behind any in-flight mutation
    const prev = pending;
    let release: () => void;
    pending = new Promise<void>((r) => {
      release = r;
    });
    await prev;

    try {
      const oldBoard = board;
      const result = mutate(oldBoard);
      if (!result.ok) return result;
      // Run pre-persist hook before advancing task state in the store.
      // If this fails (e.g., disk-full writing result file), the task
      // state is never persisted, so the caller can safely retry.
      if (beforePersist !== undefined) {
        await beforePersist();
      }
      await persistBoardDiff(store, oldBoard, result.value);
      board = result.value;
      return result;
    } catch (err: unknown) {
      // Translate store-layer exceptions (version conflicts, corrupt files,
      // I/O errors) into typed KoiError results instead of raw rejections.
      const message = err instanceof Error ? err.message : String(err);
      const code = message.includes("Version conflict") ? "CONFLICT" : "EXTERNAL";
      return {
        ok: false,
        error: {
          code,
          message: `Persistence failed: ${message}`,
          retryable: code === "EXTERNAL",
          context: { cause: message },
        },
      };
    } finally {
      release!();
    }
  }

  return {
    snapshot: () => board,

    nextId: () => Promise.resolve(store.nextId()),

    hasResultPersistence: () => resultsDir !== undefined,

    add: (input) => applyMutation((b) => b.add(input)),

    addAll: (inputs) => applyMutation((b) => b.addAll(inputs)),

    assign: (taskId, agentId) => applyMutation((b) => b.assign(taskId, agentId)),

    startTask: (taskId, agentId) =>
      applyMutation((b) => {
        const inProgress = b.inProgress();
        if (inProgress.length > 0) {
          const blocking = inProgress[0];
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: `Cannot start task '${taskId}': task '${blocking?.id ?? "unknown"}' is already in_progress. Complete or stop the current task first.`,
              retryable: false,
              context: { blockingTaskId: blocking?.id ?? "unknown" },
            },
          };
        }
        return b.assign(taskId, agentId);
      }),

    complete: (taskId, taskResult) =>
      applyMutation(
        (b) => b.complete(taskId, taskResult),
        resultsDir !== undefined
          ? async () => persistResult(resultsDir, taskResult)
          : undefined,
      ),

    completeOwnedTask: (taskId, agentId, taskResult) =>
      applyMutation(
        (b) => {
          const task = b.get(taskId);
          if (task === undefined) {
            return {
              ok: false,
              error: { code: "NOT_FOUND", message: `Task not found: ${taskId}`, retryable: false },
            };
          }
          if (task.status === "in_progress" && task.assignedTo !== agentId) {
            return {
              ok: false,
              error: {
                code: "CONFLICT",
                message: `Cannot complete task '${taskId}': assigned to '${String(task.assignedTo)}', not '${String(agentId)}'`,
                retryable: false,
              },
            };
          }
          return b.complete(taskId, taskResult);
        },
        resultsDir !== undefined
          ? async () => persistResult(resultsDir, taskResult)
          : undefined,
      ),

    fail: (taskId, error) => applyMutation((b) => b.fail(taskId, error)),

    failOwnedTask: (taskId, agentId, error) =>
      applyMutation((b) => {
        const task = b.get(taskId);
        if (task === undefined) {
          return {
            ok: false,
            error: { code: "NOT_FOUND", message: `Task not found: ${taskId}`, retryable: false },
          };
        }
        if (task.status === "in_progress" && task.assignedTo !== agentId) {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: `Cannot fail task '${taskId}': assigned to '${String(task.assignedTo)}', not '${String(agentId)}'`,
              retryable: false,
            },
          };
        }
        return b.fail(taskId, error);
      }),

    kill: (taskId) => applyMutation((b) => b.kill(taskId)),

    killOwnedTask: (taskId, agentId) =>
      applyMutation((b) => {
        const task = b.get(taskId);
        if (task === undefined) {
          return {
            ok: false,
            error: { code: "NOT_FOUND", message: `Task not found: ${taskId}`, retryable: false },
          };
        }
        if (task.status === "in_progress" && task.assignedTo !== agentId) {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: `Cannot kill task '${taskId}': assigned to '${String(task.assignedTo)}', not '${String(agentId)}'`,
              retryable: false,
            },
          };
        }
        return b.kill(taskId);
      }),

    update: (taskId, patch) => applyMutation((b) => b.update(taskId, patch)),

    updateOwned: (taskId, agentId, patch) =>
      applyMutation((b) => {
        const task = b.get(taskId);
        if (task === undefined) {
          return {
            ok: false,
            error: { code: "NOT_FOUND", message: `Task not found: ${taskId}`, retryable: false },
          };
        }
        // Reject cross-agent metadata writes on in_progress tasks
        if (task.status === "in_progress" && task.assignedTo !== agentId) {
          return {
            ok: false,
            error: {
              code: "CONFLICT",
              message: `Cannot update task '${taskId}': assigned to '${String(task.assignedTo)}', not '${String(agentId)}'`,
              retryable: false,
            },
          };
        }
        return b.update(taskId, patch);
      }),

    [Symbol.asyncDispose]: async () => {
      await store[Symbol.asyncDispose]();
    },
  };
}
