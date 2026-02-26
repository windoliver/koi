/**
 * assign_worker tool — assigns a ready task to a worker and spawns it.
 */

import type { AgentId } from "@koi/core";
import { taskItemId } from "@koi/core";
import type { BoardHolder } from "./orchestrate-tool.js";
import type { OrchestratorConfig } from "./types.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "./types.js";

interface AssignWorkerInput {
  readonly task_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseInput(raw: unknown): AssignWorkerInput | string {
  if (!isRecord(raw)) return "Input must be a non-null object";
  if (typeof raw.task_id !== "string" || raw.task_id.length === 0) {
    return "'task_id' is required and must be a non-empty string";
  }
  return { task_id: raw.task_id };
}

// let justified: monotonic counter for generating worker IDs
let workerCounter = 0;

function nextWorkerId(): AgentId {
  workerCounter += 1;
  return `worker-${workerCounter}` as AgentId;
}

/**
 * Executes the assign_worker tool.
 */
export async function executeAssignWorker(
  raw: unknown,
  holder: BoardHolder,
  config: OrchestratorConfig,
  signal: AbortSignal,
): Promise<string> {
  const input = parseInput(raw);
  if (typeof input === "string") return input;

  if (signal.aborted) {
    return "Orchestration timed out";
  }

  const id = taskItemId(input.task_id);
  const board = holder.getBoard();
  const maxConcurrency = config.maxConcurrency ?? DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrency;

  // Check concurrency limit
  if (board.inProgress().length >= maxConcurrency) {
    return `Concurrency limit reached (${maxConcurrency}). Wait for a task to complete before assigning more.`;
  }

  // Assign task on the board
  const workerId = nextWorkerId();
  const assignResult = board.assign(id, workerId);
  if (!assignResult.ok) {
    return `Cannot assign task ${input.task_id}: ${assignResult.error.message}`;
  }
  holder.setBoard(assignResult.value);

  const item = assignResult.value.get(id);
  if (item === undefined) {
    return `Internal error: task ${input.task_id} not found after assignment`;
  }

  // Spawn the worker
  const spawnResult = await config.spawn({
    taskId: id,
    description: item.description,
    agentId: workerId as string,
    signal,
  });

  if (spawnResult.ok) {
    const maxOutput = config.maxOutputPerTask ?? DEFAULT_ORCHESTRATOR_CONFIG.maxOutputPerTask;
    const output =
      spawnResult.output.length > maxOutput
        ? `${spawnResult.output.slice(0, maxOutput)}... (truncated)`
        : spawnResult.output;

    const completeResult = holder.getBoard().complete(id, {
      taskId: id,
      output,
      durationMs: 0,
      workerId: workerId as string,
    });
    if (completeResult.ok) {
      holder.setBoard(completeResult.value);
      return `Task ${input.task_id} completed by ${workerId as string}. Output: ${output.slice(0, 200)}`;
    }
    return `Task ${input.task_id} spawn succeeded but completion failed: ${completeResult.error.message}`;
  }

  // Spawn failed — fail the task on the board
  const failResult = holder.getBoard().fail(id, spawnResult.error);
  if (failResult.ok) {
    holder.setBoard(failResult.value);
    const task = failResult.value.get(id);
    if (task?.status === "pending") {
      return `Task ${input.task_id} failed (${spawnResult.error.message}), retrying (attempt ${task.retries}/${task.maxRetries})`;
    }
    return `Task ${input.task_id} failed permanently: ${spawnResult.error.message}`;
  }
  return `Task ${input.task_id} spawn failed: ${spawnResult.error.message}`;
}

/** Reset worker counter (for testing). */
export function resetWorkerCounter(): void {
  workerCounter = 0;
}
