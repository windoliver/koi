/**
 * Pure bridge: maps TaskBoardEvent + post-mutation board snapshot → EngineEvent[].
 *
 * Produces `task_progress` for every transition, plus `plan_update` snapshots
 * on structural changes (add, complete, fail, kill, unreachable, update).
 */

import type {
  AgentId,
  EngineEvent,
  Task,
  TaskBoard,
  TaskBoardConfig,
  TaskBoardEvent,
  TaskBoardSnapshot,
  TaskItemId,
  TaskStatus,
} from "@koi/core";
import { createTaskBoard } from "./board.js";

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

/** Builds a lightweight plan_update snapshot from the post-mutation board. */
function buildPlanUpdate(
  board: TaskBoard,
  agentId: AgentId,
  timestamp: number,
): EngineEvent & { readonly kind: "plan_update" } {
  const unreachableSet = new Set<TaskItemId>(board.unreachable().map((t) => t.id));
  // Build a blockedBy index from unreachable tasks' dependencies
  const blockedByMap = new Map<TaskItemId, TaskItemId>();
  for (const task of board.unreachable()) {
    for (const dep of task.dependencies) {
      const depTask = board.get(dep);
      if (depTask !== undefined && (depTask.status === "failed" || depTask.status === "killed")) {
        blockedByMap.set(task.id, dep);
        break;
      }
      if (unreachableSet.has(dep)) {
        blockedByMap.set(task.id, dep);
        break;
      }
    }
  }

  const tasks = board.all().map((t: Task) => ({
    id: t.id,
    subject: t.subject,
    status: t.status,
    ...(t.assignedTo !== undefined ? { assignedTo: t.assignedTo } : {}),
    // Only include activeForm for in_progress tasks — prevents stale spinner text
    // from retry/unassign paths that don't clear activeForm on the board
    ...(t.activeForm !== undefined && t.status === "in_progress"
      ? { activeForm: t.activeForm }
      : {}),
    ...(blockedByMap.has(t.id) ? { blockedBy: blockedByMap.get(t.id) } : {}),
    dependencies: t.dependencies,
  }));

  return {
    kind: "plan_update",
    agentId,
    tasks,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Previous status derivation
// ---------------------------------------------------------------------------

/** Derives previousStatus from event kind. Deterministic for all except task:killed. */
function derivePreviousStatus(event: TaskBoardEvent, board: TaskBoard): TaskStatus {
  switch (event.kind) {
    case "task:added":
      return "pending";
    case "task:assigned":
      return "pending";
    case "task:unassigned":
      return "in_progress";
    case "task:completed":
      return "in_progress";
    case "task:failed":
      return "in_progress";
    case "task:retried":
      return "in_progress";
    case "task:killed":
      return event.previousStatus;
    case "task:unreachable":
      return "pending";
    case "task:updated": {
      const task = board.get(event.taskId);
      return task?.status ?? "pending";
    }
  }
}

/** Derives the new status after the event. */
function deriveNewStatus(event: TaskBoardEvent, board: TaskBoard): TaskStatus {
  switch (event.kind) {
    case "task:added":
      return "pending";
    case "task:assigned":
      return "in_progress";
    case "task:unassigned":
      return "pending";
    case "task:completed":
      return "completed";
    case "task:failed":
      return "failed";
    case "task:retried":
      return "pending";
    case "task:killed":
      return "killed";
    case "task:unreachable":
      return "pending";
    case "task:updated": {
      const task = board.get(event.taskId);
      return task?.status ?? "pending";
    }
  }
}

/** Gets the subject for an event's task. */
function deriveSubject(event: TaskBoardEvent, board: TaskBoard): string {
  if (event.kind === "task:added") return event.task.subject;
  const task = board.get(event.taskId);
  return task?.subject ?? "";
}

/** Gets the activeForm for an event's task. */
function deriveActiveForm(event: TaskBoardEvent, board: TaskBoard): string | undefined {
  if (event.kind === "task:added") return event.task.activeForm;
  const task = board.get(event.taskId);
  return task?.activeForm;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Events that trigger a plan_update snapshot in addition to task_progress.
 * Excluded from snapshots (upserted via task_progress instead):
 * - task:added — addAll() emits one per task, producing O(N^2) snapshot traffic
 * - task:unreachable — fail/kill cascade emits one per descendant, same O(N) problem
 * - task:assigned, task:unassigned, task:retried — non-structural status changes
 */
const STRUCTURAL_EVENTS = new Set<TaskBoardEvent["kind"]>([
  "task:completed",
  "task:failed",
  "task:killed",
  "task:updated",
]);

/**
 * Maps a TaskBoardEvent + post-mutation board to EngineEvent(s).
 *
 * Always produces at least one `task_progress` event.
 * Structural changes also produce a `plan_update` snapshot.
 *
 * @param boardOwner - Agent that owns this board. Used as agentId on all emitted
 *   events. A shared board is a shared plan — consumers key by boardOwner, not
 *   per-task assignee, so all events from one board appear in one plan view.
 */
export function mapTaskBoardEventToEngineEvents(
  event: TaskBoardEvent,
  board: TaskBoard,
  boardOwner: AgentId,
  clock: () => number = Date.now,
): readonly EngineEvent[] {
  const timestamp = clock();
  const taskId = event.kind === "task:added" ? event.task.id : event.taskId;
  const previousStatus = derivePreviousStatus(event, board);
  const status = deriveNewStatus(event, board);
  const subject = deriveSubject(event, board);
  const activeForm = deriveActiveForm(event, board);

  // Only include activeForm for in_progress tasks — pending/completed/failed/killed
  // tasks should not carry stale spinner text from a prior active phase.
  const includeActiveForm = activeForm !== undefined && status === "in_progress";

  const progress: EngineEvent = {
    kind: "task_progress",
    agentId: boardOwner,
    taskId,
    subject,
    previousStatus,
    status,
    ...(includeActiveForm ? { activeForm } : {}),
    ...(event.kind === "task:failed" ? { detail: event.error.message } : {}),
    timestamp,
  };

  if (STRUCTURAL_EVENTS.has(event.kind)) {
    return [progress, buildPlanUpdate(board, boardOwner, timestamp)];
  }

  return [progress];
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/** Options for creating a task board pre-wired to emit EngineEvents. */
export interface WiredTaskBoardOptions {
  readonly agentId: AgentId;
  readonly onEngineEvent: (event: EngineEvent) => void;
  readonly config?: Omit<TaskBoardConfig, "onEvent"> | undefined;
  readonly initial?: TaskBoardSnapshot | undefined;
  readonly clock?: (() => number) | undefined;
}

/**
 * Creates a TaskBoard that automatically emits plan_update / task_progress
 * EngineEvents on every mutation via the provided callback.
 *
 * This is the recommended way to connect a TaskBoard to an engine event stream.
 *
 * @example
 * ```ts
 * const board = createWiredTaskBoard({
 *   agentId: myAgentId,
 *   onEngineEvent: (event) => pendingEvents.push(event),
 * });
 * ```
 */
export function createWiredTaskBoard(options: WiredTaskBoardOptions): TaskBoard {
  const { agentId, onEngineEvent, config, initial, clock } = options;
  return createTaskBoard(
    {
      ...config,
      onEvent: (event, board) => {
        const engineEvents = mapTaskBoardEventToEngineEvents(event, board, agentId, clock);
        for (const e of engineEvents) {
          onEngineEvent(e);
        }
      },
    },
    initial,
  );
}
