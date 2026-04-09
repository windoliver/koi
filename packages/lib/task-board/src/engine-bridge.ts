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

/** Finds the first incomplete dependency for a pending task, if any. */
function findBlocker(task: Task, board: TaskBoard): TaskItemId | undefined {
  for (const dep of task.dependencies) {
    const depTask = board.get(dep);
    if (depTask === undefined || depTask.status !== "completed") {
      return dep;
    }
  }
  return undefined;
}

/**
 * Builds a plan_update EngineEvent from the current board state.
 * Used internally by the bridge and exported for initial snapshot emission.
 */
export function buildPlanUpdate(
  board: TaskBoard,
  agentId: AgentId,
  timestamp: number,
): EngineEvent & { readonly kind: "plan_update" } {
  const tasks = board.all().map((t: Task) => {
    // Compute blockedBy for any pending task with incomplete dependencies
    const blocker = t.status === "pending" ? findBlocker(t, board) : undefined;
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      ...(t.assignedTo !== undefined ? { assignedTo: t.assignedTo } : {}),
      // Only include activeForm for in_progress tasks — prevents stale spinner text
      // from retry/unassign paths that don't clear activeForm on the board
      ...(t.activeForm !== undefined && t.status === "in_progress"
        ? { activeForm: t.activeForm }
        : {}),
      ...(blocker !== undefined ? { blockedBy: blocker } : {}),
      dependencies: t.dependencies,
    };
  });

  return {
    kind: "plan_update",
    agentId,
    tasks,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Status transition derivation
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the `(previousStatus, newStatus)` pair per event kind.
 *
 * Replaces the prior pair of mirror-image switches (`derivePreviousStatus` and
 * `deriveNewStatus`) so adding a new `TaskBoardEvent` kind only requires updating
 * one switch — and TypeScript's exhaustiveness checking will fail compilation if
 * any kind is missed.
 *
 * Two cases are dynamic and need access to the event payload or board state:
 * - `task:killed` — previous status comes from the event payload (preserves
 *   the pre-kill state, which can be either `pending` or `in_progress`).
 * - `task:updated` — both before and after are the task's current status,
 *   because `update()` patches metadata only and never changes status.
 */
function resolveStatusTransition(
  event: TaskBoardEvent,
  board: TaskBoard,
): readonly [previousStatus: TaskStatus, newStatus: TaskStatus] {
  switch (event.kind) {
    case "task:added":
      return ["pending", "pending"];
    case "task:assigned":
      return ["pending", "in_progress"];
    case "task:unassigned":
      return ["in_progress", "pending"];
    case "task:completed":
      return ["in_progress", "completed"];
    case "task:failed":
      return ["in_progress", "failed"];
    case "task:retried":
      return ["in_progress", "pending"];
    case "task:killed":
      return [event.previousStatus, "killed"];
    case "task:unreachable":
      return ["pending", "pending"];
    case "task:updated": {
      const status = board.get(event.taskId)?.status ?? "pending";
      return [status, status];
    }
    // No `default` case — TypeScript's exhaustiveness check enforces that
    // every TaskBoardEvent kind has an explicit return above. Adding a new
    // kind to TaskBoardEvent without updating this switch is a compile error.
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
  const [previousStatus, status] = resolveStatusTransition(event, board);
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
    ...(event.kind === "task:unreachable" ? { blockedBy: event.blockedBy } : {}),
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
