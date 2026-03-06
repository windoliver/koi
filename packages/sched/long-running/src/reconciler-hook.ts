/**
 * Reconciler hook — optional cadence-gated external reconciliation.
 *
 * Separates cadence gating (turn-based) from reconciler.check() (external state).
 * On timeout or error, proceeds without changes (fail-open for liveness).
 */

import type { TaskBoard, TaskReconcileAction, TaskReconciler } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcilerHookConfig {
  readonly reconciler: TaskReconciler;
  readonly intervalTurns?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ReconcilerHook {
  readonly shouldCheck: (turnCount: number) => boolean;
  readonly reconcile: (board: TaskBoard) => Promise<TaskBoard>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_TURNS = 5;
const DEFAULT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReconcilerHook(config: ReconcilerHookConfig): ReconcilerHook {
  const interval = config.intervalTurns ?? DEFAULT_INTERVAL_TURNS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function shouldCheck(turnCount: number): boolean {
    return turnCount % interval === 0;
  }

  async function reconcile(board: TaskBoard): Promise<TaskBoard> {
    // let justified: actions may fail to fetch
    let actions: readonly TaskReconcileAction[];

    try {
      actions = await Promise.race([
        config.reconciler.check({ items: board.all(), results: board.completed() }),
        new Promise<readonly TaskReconcileAction[]>((_, reject) =>
          setTimeout(() => reject(new Error("Reconciler timeout")), timeoutMs),
        ),
      ]);
    } catch {
      // Timeout or reconciler error — proceed without changes
      return board;
    }

    if (actions.length === 0) return board;

    // let justified: board is replaced through immutable updates in the loop
    let currentBoard = board;

    for (const action of actions) {
      switch (action.kind) {
        case "cancel": {
          const item = currentBoard.get(action.taskId);
          if (item === undefined) break;
          const failResult = currentBoard.fail(action.taskId, {
            code: "CANCELLED",
            message: `Reconciler cancelled: ${action.reason}`,
            retryable: false,
          });
          if (failResult.ok) {
            currentBoard = failResult.value;
          }
          break;
        }
        case "update": {
          const item = currentBoard.get(action.taskId);
          if (item === undefined) break;
          const updateResult = currentBoard.update(action.taskId, {
            description: action.description,
          });
          if (updateResult.ok) {
            currentBoard = updateResult.value;
          }
          break;
        }
        case "add": {
          const addResult = currentBoard.add(action.task);
          if (addResult.ok) {
            currentBoard = addResult.value;
          }
          break;
        }
      }
    }

    return currentBoard;
  }

  return { shouldCheck, reconcile };
}
