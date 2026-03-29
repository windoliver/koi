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

  async function dispatchReady(board: TaskBoard): Promise<TaskBoard> {
    // let justified: board is mutated through immutable replacements in the loop
    let currentBoard = board;
    // let justified: tracks whether we need to re-scan for newly ready tasks
    let changed = true;

    while (changed) {
      changed = false;
      const readySpawnTasks = currentBoard.ready().filter((t) => t.delegation === "spawn");

      if (readySpawnTasks.length === 0) break;

      // Phase 1 (sequential): Claim all ready tasks via board.assign().
      // This is fast (microseconds) and must be sequential because each
      // assign returns a new immutable board snapshot.
      const claimed: Array<{ readonly task: TaskItem; readonly board: TaskBoard }> = [];
      for (const task of readySpawnTasks) {
        if (controller.signal.aborted) break;

        const agentName = task.agentType ?? "worker";
        const workerAgentId: AgentId = brandAgentId(`worker-${task.id}`);

        const assignResult = currentBoard.assign(task.id, workerAgentId);
        if (!assignResult.ok) continue; // Race/conflict — skip

        currentBoard = assignResult.value;
        claimed.push({
          task: { ...task, assignedTo: workerAgentId } as TaskItem,
          board: currentBoard,
        });
        void agentName; // used in phase 2 via task.agentType
      }

      if (claimed.length === 0) break;

      // Phase 2 (parallel): Spawn all claimed tasks concurrently.
      // The semaphore limits actual concurrency. Each spawn is independent
      // because claiming already happened.
      const spawnResults = await Promise.all(
        claimed.map(async ({ task }) => {
          const agentName = task.agentType ?? "worker";
          const workerAgentId: AgentId = brandAgentId(`worker-${task.id}`);

          // Build upstream context from completed dependencies
          const upstreamResults: TaskResult[] = [];
          for (const depId of task.dependencies) {
            const depResult = currentBoard.result(depId);
            if (depResult !== undefined) {
              upstreamResults.push(depResult);
            }
          }
          const contextBlock = formatUpstreamContext(upstreamResults, maxUpstreamContext);
          const description =
            contextBlock.length > 0 ? `${contextBlock}\n\n${task.description}` : task.description;

          config.onTaskDispatched?.(task.id);

          await semaphore.acquire(task.agentType);
          inFlight += 1;

          try {
            if (controller.signal.aborted) {
              return { taskId: task.id, ok: false as const, cascadeNeeded: false };
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
              const output =
                result.output.length > maxOutput
                  ? `${result.output.slice(0, maxOutput)}... (truncated)`
                  : result.output;
              return {
                taskId: task.id,
                ok: true as const,
                cascadeNeeded: true,
                output,
                workerId: workerAgentId,
                durationMs: 0,
              };
            }

            return {
              taskId: task.id,
              ok: false as const,
              cascadeNeeded: false,
              error: { code: "EXTERNAL" as const, message: result.error.message, retryable: true },
            };
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            const item = currentBoard.get(task.id);
            const retries = item?.retries ?? 0;
            return {
              taskId: task.id,
              ok: false as const,
              cascadeNeeded: false,
              error: {
                code: "EXTERNAL" as const,
                message: `Spawn abnormal failure: ${message}`,
                retryable: true,
                context: { backoffMs: computeBackoff(retries + 1), abnormal: true },
              },
            };
          } finally {
            inFlight -= 1;
            semaphore.release(task.agentType);
          }
        }),
      );

      // Phase 3 (sequential): Apply spawn results back to the board.
      for (const sr of spawnResults) {
        if (sr.ok) {
          const completeResult = currentBoard.complete(sr.taskId, {
            taskId: sr.taskId,
            output: sr.output,
            durationMs: sr.durationMs,
            workerId: sr.workerId,
          });
          config.onTaskCompleted?.(sr.taskId);
          if (completeResult.ok) {
            currentBoard = completeResult.value;
            changed = true;
          }
        } else if (sr.error !== undefined) {
          const failResult = currentBoard.fail(sr.taskId, sr.error);
          if (failResult.ok) {
            currentBoard = failResult.value;
          }
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
