/**
 * Delegation bridge — auto-dispatch spawn tasks from the task board.
 *
 * Implements the Symphony single-authority + claimed-set pattern:
 * 1. Scan board.ready() for delegation === "spawn" tasks
 * 2. Claim via board.assign() before dispatching (prevents duplicate dispatch)
 * 3. Spawn with DEFERRED delivery policy
 * 4. On result: complete or fail with retry
 * 5. Cascade: re-check for newly unblocked tasks
 */

import type {
  AgentId,
  DeliveryPolicy,
  SpawnFn,
  TaskBoard,
  TaskItem,
  TaskItemId,
  TaskResult,
} from "@koi/core";
import { agentId as brandAgentId } from "@koi/core";
import { formatUpstreamContext } from "@koi/task-board";
import type { ConcurrencyGate } from "./lane-semaphore.js";
import { createLaneSemaphore } from "./lane-semaphore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegationBridgeConfig {
  readonly spawn: SpawnFn;
  readonly deliveryPolicy?: DeliveryPolicy | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly laneConcurrency?: ReadonlyMap<string, number> | undefined;
  readonly maxOutputPerTask?: number | undefined;
  readonly maxUpstreamContextPerTask?: number | undefined;
  readonly onTaskDispatched?: ((taskId: TaskItemId) => void) | undefined;
  readonly onTaskCompleted?: ((taskId: TaskItemId) => void) | undefined;
}

export interface DelegationBridge {
  /** Scan and dispatch ready spawn tasks. Returns updated board. */
  readonly dispatchReady: (board: TaskBoard) => Promise<TaskBoard>;
  /** Abort all in-flight spawns. */
  readonly abort: () => void;
  /** Number of currently in-flight spawns. */
  readonly inFlightCount: () => number;
}

// ---------------------------------------------------------------------------
// Backoff computation
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 300_000;
const BASE_BACKOFF_MS = 10_000;

/** Compute exponential backoff: min(10s * 2^(retries-1), 5min). */
export function computeBackoff(retries: number): number {
  if (retries <= 0) return 0;
  return Math.min(BASE_BACKOFF_MS * 2 ** (retries - 1), MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_MAX_OUTPUT = 5000;
const DEFAULT_MAX_UPSTREAM_CONTEXT = 2000;

const DEFERRED_DELIVERY: DeliveryPolicy = Object.freeze({ kind: "deferred" } as const);

export function createDelegationBridge(config: DelegationBridgeConfig): DelegationBridge {
  const deliveryPolicy = config.deliveryPolicy ?? DEFERRED_DELIVERY;
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxOutput = config.maxOutputPerTask ?? DEFAULT_MAX_OUTPUT;
  const maxUpstreamContext = config.maxUpstreamContextPerTask ?? DEFAULT_MAX_UPSTREAM_CONTEXT;

  const semaphore: ConcurrencyGate = createLaneSemaphore(maxConcurrency, config.laneConcurrency);

  const controller = new AbortController();
  // let justified: mutable in-flight counter
  let inFlight = 0;

  async function dispatchOne(
    task: TaskItem,
    board: TaskBoard,
  ): Promise<{ readonly board: TaskBoard; readonly cascadeNeeded: boolean }> {
    const agentName = task.agentType ?? "worker";
    const workerAgentId: AgentId = brandAgentId(`worker-${task.id}`);

    // Step 1: Claim — assign before dispatch (Symphony claimed-set pattern)
    const assignResult = board.assign(task.id, workerAgentId);
    if (!assignResult.ok) {
      // Race/conflict — another process claimed it; skip
      return { board, cascadeNeeded: false };
    }

    const assignedBoard = assignResult.value;

    // Step 2: Build upstream context from completed dependencies
    const upstreamResults: TaskResult[] = [];
    for (const depId of task.dependencies) {
      const depResult = assignedBoard.result(depId);
      if (depResult !== undefined) {
        upstreamResults.push(depResult);
      }
    }
    const contextBlock = formatUpstreamContext(upstreamResults, maxUpstreamContext);
    const description =
      contextBlock.length > 0 ? `${contextBlock}\n\n${task.description}` : task.description;

    config.onTaskDispatched?.(task.id);

    // Step 3: Acquire semaphore + spawn
    await semaphore.acquire(task.agentType);
    inFlight += 1;

    try {
      if (controller.signal.aborted) {
        return { board: assignedBoard, cascadeNeeded: false };
      }

      const result = await config.spawn({
        description,
        agentName,
        signal: controller.signal,
        taskId: task.id,
        agentId: workerAgentId,
        delivery: deliveryPolicy,
      });

      if (result.ok) {
        // Clean success → complete
        const output =
          result.output.length > maxOutput
            ? `${result.output.slice(0, maxOutput)}... (truncated)`
            : result.output;

        const completeResult = assignedBoard.complete(task.id, {
          taskId: task.id,
          output,
          durationMs: 0,
          workerId: workerAgentId,
        });

        config.onTaskCompleted?.(task.id);

        if (completeResult.ok) {
          return { board: completeResult.value, cascadeNeeded: true };
        }
        return { board: assignedBoard, cascadeNeeded: false };
      }

      // Clean failure (worker returned error) → fail with retryable
      const failResult = assignedBoard.fail(task.id, {
        code: "EXTERNAL",
        message: result.error.message,
        retryable: true,
      });

      if (failResult.ok) {
        return { board: failResult.value, cascadeNeeded: false };
      }
      return { board: assignedBoard, cascadeNeeded: false };
    } catch (e: unknown) {
      // Abnormal failure (throw/timeout) → fail + exponential backoff flag
      const message = e instanceof Error ? e.message : String(e);
      const item = assignedBoard.get(task.id);
      const retries = item?.retries ?? 0;

      const failResult = assignedBoard.fail(task.id, {
        code: "EXTERNAL",
        message: `Spawn abnormal failure: ${message}`,
        retryable: true,
        context: {
          backoffMs: computeBackoff(retries + 1),
          abnormal: true,
        },
      });

      if (failResult.ok) {
        return { board: failResult.value, cascadeNeeded: false };
      }
      return { board: assignedBoard, cascadeNeeded: false };
    } finally {
      inFlight -= 1;
      semaphore.release(task.agentType);
    }
  }

  async function dispatchReady(board: TaskBoard): Promise<TaskBoard> {
    // let justified: board is mutated through immutable replacements in the loop
    let currentBoard = board;
    // let justified: tracks whether we need to re-scan for newly ready tasks
    let changed = true;

    while (changed) {
      changed = false;
      const readySpawnTasks = currentBoard.ready().filter((t) => t.delegation === "spawn");

      if (readySpawnTasks.length === 0) break;

      // Dispatch all ready spawn tasks concurrently
      const dispatches = readySpawnTasks.map((task) => dispatchOne(task, currentBoard));
      const results = await Promise.all(dispatches);

      for (const result of results) {
        currentBoard = result.board;
        if (result.cascadeNeeded) {
          changed = true;
        }
      }
    }

    return currentBoard;
  }

  return {
    dispatchReady,
    abort: () => controller.abort("delegation bridge aborted"),
    inFlightCount: () => inFlight,
  };
}
