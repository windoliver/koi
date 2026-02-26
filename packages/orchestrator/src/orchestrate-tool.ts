/**
 * orchestrate tool — board CRUD via discriminated action field.
 */

import type { TaskBoard, TaskItem, TaskItemId, TaskItemInput } from "@koi/core";
import { taskItemId } from "@koi/core";

// ---------------------------------------------------------------------------
// Input types (discriminated by action)
// ---------------------------------------------------------------------------

interface AddAction {
  readonly action: "add";
  readonly tasks: readonly {
    readonly id: string;
    readonly description: string;
    readonly dependencies?: readonly string[] | undefined;
    readonly priority?: number | undefined;
    readonly maxRetries?: number | undefined;
  }[];
}

interface QueryAction {
  readonly action: "query";
  readonly view?:
    | "summary"
    | "ready"
    | "pending"
    | "blocked"
    | "in_progress"
    | "completed"
    | "failed"
    | "all"
    | undefined;
}

interface UpdateAction {
  readonly action: "update";
  readonly taskId: string;
  readonly patch: {
    readonly priority?: number | undefined;
    readonly description?: string | undefined;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  };
}

type OrchestrateInput = AddAction | QueryAction | UpdateAction;

// ---------------------------------------------------------------------------
// Board holder (mutable reference to immutable board)
// ---------------------------------------------------------------------------

export interface BoardHolder {
  readonly getBoard: () => TaskBoard;
  readonly setBoard: (board: TaskBoard) => void;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseInput(raw: unknown): OrchestrateInput | string {
  if (!isRecord(raw)) return "Input must be a non-null object";
  const action = raw.action;
  if (action !== "add" && action !== "query" && action !== "update") {
    return `Invalid action '${String(action)}'. Must be 'add', 'query', or 'update'.`;
  }
  return raw as unknown as OrchestrateInput;
}

function findFirstFailedDep(
  item: TaskItem,
  board: TaskBoard,
  visited: Set<TaskItemId> = new Set(),
): TaskItemId | undefined {
  for (const dep of item.dependencies) {
    if (visited.has(dep)) continue;
    visited.add(dep);
    const depItem = board.get(dep);
    if (depItem?.status === "failed") return dep;
  }
  // Check transitive deps
  for (const dep of item.dependencies) {
    const depItem = board.get(dep);
    if (depItem !== undefined && depItem.status === "pending") {
      const transitive = findFirstFailedDep(depItem, board, visited);
      if (transitive !== undefined) return transitive;
    }
  }
  return undefined;
}

function formatSummary(board: TaskBoard): string {
  const all = board.all();
  const ready = board.ready();
  const inProg = board.inProgress();
  const completed = board.completed();
  const failed = board.failed();
  const blocked = board.blocked();
  const unreachableItems = board.unreachable();

  const lines: string[] = [
    `Total: ${all.length} | Ready: ${ready.length} | In-progress: ${inProg.length} | Completed: ${completed.length} | Failed: ${failed.length} | Blocked: ${blocked.length} | Unreachable: ${unreachableItems.length}`,
  ];

  if (inProg.length > 0) {
    lines.push(`Workers: ${inProg.map((t) => `${t.id}→${t.assignedTo ?? "?"}`).join(", ")}`);
  }
  if (failed.length > 0) {
    lines.push(
      `Failures: ${failed.map((t) => `${t.id}: ${t.error?.message ?? "unknown"}`).join("; ")}`,
    );
  }
  if (unreachableItems.length > 0) {
    const details = unreachableItems.map((t) => {
      const failedDep = findFirstFailedDep(t, board);
      return `${t.id}→blocked by ${failedDep ?? "unknown"}`;
    });
    lines.push(`Unreachable: ${details.join(", ")}`);
  }

  return lines.join("\n");
}

function formatTaskList(
  items: readonly {
    readonly id: TaskItemId;
    readonly description: string;
    readonly status: string;
  }[],
): string {
  if (items.length === 0) return "(none)";
  return items.map((t) => `- ${t.id}: ${t.description} [${t.status}]`).join("\n");
}

function handleAdd(input: AddAction, holder: BoardHolder): string {
  const board = holder.getBoard();
  const mapped: readonly TaskItemInput[] = input.tasks.map((t) => ({
    id: taskItemId(t.id),
    description: t.description,
    dependencies: t.dependencies?.map(taskItemId),
    priority: t.priority,
    maxRetries: t.maxRetries,
  }));

  const result = board.addAll(mapped);
  if (!result.ok) {
    return `Error adding tasks: ${result.error.message}`;
  }
  holder.setBoard(result.value);
  const ready = result.value.ready();
  return `Added ${mapped.length} task(s). Ready: ${ready.length}. Total: ${result.value.size()}.`;
}

function handleQuery(input: QueryAction, holder: BoardHolder): string {
  const board = holder.getBoard();
  const view = input.view ?? "summary";

  switch (view) {
    case "summary":
      return formatSummary(board);
    case "ready":
      return formatTaskList(board.ready());
    case "pending":
      return formatTaskList(board.pending());
    case "blocked":
      return formatTaskList(board.blocked());
    case "in_progress":
      return formatTaskList(board.inProgress());
    case "completed":
      return board.completed().length === 0
        ? "(none)"
        : board
            .completed()
            .map((r) => `- ${r.taskId}: ${r.output.slice(0, 200)}`)
            .join("\n");
    case "failed":
      return formatTaskList(board.failed());
    case "all":
      return formatTaskList(board.all());
    default: {
      const _exhaustive: never = view;
      return `Unknown view: ${String(_exhaustive)}`;
    }
  }
}

function handleUpdate(input: UpdateAction, holder: BoardHolder): string {
  const board = holder.getBoard();
  const id = taskItemId(input.taskId);
  const result = board.update(id, input.patch);
  if (!result.ok) {
    return `Error updating task ${input.taskId}: ${result.error.message}`;
  }
  holder.setBoard(result.value);
  const updated = result.value.get(id);
  const fields: string[] = [];
  if (input.patch.priority !== undefined) fields.push(`priority=${input.patch.priority}`);
  if (input.patch.description !== undefined)
    fields.push(`description="${input.patch.description}"`);
  if (input.patch.metadata !== undefined) fields.push("metadata=updated");
  return `Task ${input.taskId} updated: ${fields.length > 0 ? fields.join(", ") : "no changes"} [${updated?.status ?? "unknown"}]`;
}

/**
 * Executes the orchestrate tool.
 */
export function executeOrchestrate(raw: unknown, holder: BoardHolder): string {
  const input = parseInput(raw);
  if (typeof input === "string") return input;

  switch (input.action) {
    case "add":
      return handleAdd(input, holder);
    case "query":
      return handleQuery(input, holder);
    case "update":
      return handleUpdate(input, holder);
    default: {
      const _exhaustive: never = input;
      return `Unknown action: ${String((_exhaustive as { readonly action: string }).action)}`;
    }
  }
}
