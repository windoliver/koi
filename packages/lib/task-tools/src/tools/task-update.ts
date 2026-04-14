import type {
  AgentId,
  JsonObject,
  KoiError,
  ManagedTaskBoard,
  Task,
  TaskItemId,
  TaskResult,
  Tool,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, taskItemId } from "@koi/core";
import { toJSONSchema, z } from "zod";
import { toTaskSummary } from "../project.js";

// ---------------------------------------------------------------------------
// Zod schema (single source of truth for validation + JSON schema)
// ---------------------------------------------------------------------------

const schema = z.object({
  task_id: z.string().min(1).describe("ID of the task to update"),
  subject: z.string().min(1).optional().describe("New short title for the task"),
  description: z.string().min(1).optional().describe("New full description"),
  active_form: z
    .string()
    .optional()
    .describe("Update the present-continuous spinner text. Cleared automatically on completion."),
  status: z
    .enum(["in_progress", "completed", "failed", "killed"])
    .optional()
    .describe(
      "Transition task status. 'in_progress' = start working (only one allowed at a time); " +
        "'completed' = done (requires output); 'failed' = errored (requires reason); 'killed' = cancelled.",
    ),
  output: z
    .string()
    .optional()
    .describe(
      "Summary of what was accomplished when status = 'completed'. " +
        "Defaults to the task subject if omitted.",
    ),
  results: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional when status = 'completed'. Structured result data (e.g. { count: 5, files: [...] }). " +
        "Validated against resultSchemas[task.metadata.kind] if configured.",
    ),
  reason: z
    .string()
    .optional()
    .describe("Required when status = 'failed'. Explanation of why the task failed."),
});

type UpdateArgs = z.infer<typeof schema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the success payload for every status transition.
 *
 * Snapshots the board once — a single callsite for the "re-read the task,
 * project to summary, fall back to bare id if the task vanished" pattern
 * that used to be inlined 5 times in execute(). Keeps response shape uniform
 * across every handler and gives us one place to add fields (e.g. result).
 */
function buildSuccess(
  board: ManagedTaskBoard,
  id: TaskItemId,
  extras?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const snapshot = board.snapshot();
  const task = snapshot.get(id);
  return {
    ok: true,
    task: task !== undefined ? toTaskSummary(task, snapshot) : { id },
    ...extras,
  };
}

function errorResponse(message: string): Readonly<Record<string, unknown>> {
  return { ok: false, error: message };
}

/**
 * durationMs: wall-clock time the task spent running.
 *
 * Prefer task.startedAt (set by the board on every pending → in_progress
 * transition and NOT bumped by activeForm patches). Fall back to updatedAt
 * for snapshots that pre-date the field — under-reports duration if
 * activeForm was patched mid-run, but matches legacy behavior so old data
 * still parses cleanly.
 */
function computeDurationMs(task: Task): number {
  const startReference = task.startedAt ?? task.updatedAt;
  return Math.max(0, Date.now() - startReference);
}

// ---------------------------------------------------------------------------
// Per-status handlers (each < 50 LOC per CLAUDE.md function-size rule)
// ---------------------------------------------------------------------------

async function handleStartInProgress(
  board: ManagedTaskBoard,
  agentId: AgentId,
  id: TaskItemId,
  taskId: string,
  activeForm: string | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  // Single-in-progress enforcement (Decision 3A)
  const inProgress = board.snapshot().inProgress();
  if (inProgress.length > 0) {
    const blocking = inProgress[0];
    return errorResponse(
      `Cannot start task '${taskId}': task '${(blocking?.id as string | undefined) ?? "unknown"}' is already in_progress. ` +
        "Complete or stop the current task first.",
    );
  }
  const assignResult = await board.assign(id, agentId);
  if (!assignResult.ok) return errorResponse(assignResult.error.message);

  if (activeForm !== undefined) {
    // Task is now in_progress and owned by agentId — updateOwned enforces that
    const patchResult = await board.updateOwned(id, agentId, { activeForm });
    if (!patchResult.ok) return errorResponse(patchResult.error.message);
  }
  return buildSuccess(board, id);
}

async function handleComplete(
  board: ManagedTaskBoard,
  agentId: AgentId,
  id: TaskItemId,
  task: Task,
  output: string | undefined,
  results: Record<string, unknown> | undefined,
  onComplete: (subject: string) => void,
): Promise<Readonly<Record<string, unknown>>> {
  // Fail fast: completing a task without durable result storage silently
  // loses the output after any process restart.
  if (!board.hasResultPersistence()) {
    return errorResponse(
      "Cannot complete task: result storage is not durable. " +
        "Create the ManagedTaskBoard with a resultsDir so completed outputs survive restarts.",
    );
  }
  // Default output to the task subject when omitted — avoids re-prompt friction
  // (#1785) while still producing a meaningful result summary.
  const resolvedOutput =
    output !== undefined && output.trim() !== "" ? output : `Completed: ${task.subject}`;
  const taskResult: TaskResult = {
    taskId: id,
    output: resolvedOutput,
    durationMs: computeDurationMs(task),
    ...(results !== undefined ? { results } : {}),
  };
  // completeOwnedTask: atomically re-checks ownership inside the lock
  const completeResult = await board.completeOwnedTask(id, agentId, taskResult);
  if (!completeResult.ok) return errorResponse(completeResult.error.message);
  onComplete(task.subject);
  return buildSuccess(board, id, { result: taskResult });
}

async function handleFail(
  board: ManagedTaskBoard,
  agentId: AgentId,
  id: TaskItemId,
  reason: string | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  if (reason === undefined || reason.trim() === "") {
    return errorResponse(
      "status 'failed' requires a non-empty 'reason' field explaining why the task failed",
    );
  }
  const err: KoiError = { code: "EXTERNAL", message: reason, retryable: false };
  // failOwnedTask: atomically re-checks ownership inside the lock
  const failResult = await board.failOwnedTask(id, agentId, err);
  if (!failResult.ok) return errorResponse(failResult.error.message);
  return buildSuccess(board, id);
}

async function handleKill(
  board: ManagedTaskBoard,
  agentId: AgentId,
  id: TaskItemId,
): Promise<Readonly<Record<string, unknown>>> {
  const killResult = await board.killOwnedTask(id, agentId);
  if (!killResult.ok) return errorResponse(killResult.error.message);
  return buildSuccess(board, id);
}

async function handleMetadataPatch(
  board: ManagedTaskBoard,
  agentId: AgentId,
  id: TaskItemId,
  args: UpdateArgs,
): Promise<Readonly<Record<string, unknown>>> {
  const hasPatch =
    args.subject !== undefined || args.description !== undefined || "active_form" in args;
  if (!hasPatch) {
    return errorResponse(
      "No fields to update — provide subject, description, active_form, or status",
    );
  }
  const patch = {
    ...(args.subject !== undefined ? { subject: args.subject } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...("active_form" in args ? { activeForm: args.active_form } : {}),
  };
  // updateOwned: atomically rejects cross-agent writes on in_progress tasks
  const patchResult = await board.updateOwned(id, agentId, patch);
  if (!patchResult.ok) return errorResponse(patchResult.error.message);
  return buildSuccess(board, id);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskUpdateTool(
  board: ManagedTaskBoard,
  agentId: AgentId,
  onComplete: (taskSubject: string) => void,
): Tool {
  return {
    descriptor: {
      name: "task_update",
      description:
        "Update a task's status, description, or progress text. " +
        "Set status to 'in_progress' when starting work (only one task may be in_progress at a time). " +
        "Set status to 'completed' with an output summary when done. " +
        "Set status to 'failed' with a reason if the task errored. " +
        "Set status to 'killed' to cancel. " +
        "Update active_form to change the live progress text shown in the spinner.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return errorResponse(parsed.error.message);
      }
      const data = parsed.data;
      const id = taskItemId(data.task_id);
      const task = board.snapshot().get(id);
      if (task === undefined) {
        return errorResponse(`Task not found: ${data.task_id}`);
      }

      // Dispatch on status when provided; fall through to metadata-only update.
      if (data.status === undefined) {
        return handleMetadataPatch(board, agentId, id, data);
      }
      switch (data.status) {
        case "in_progress":
          return handleStartInProgress(board, agentId, id, data.task_id, data.active_form);
        case "completed":
          return handleComplete(board, agentId, id, task, data.output, data.results, onComplete);
        case "failed":
          return handleFail(board, agentId, id, data.reason);
        case "killed":
          return handleKill(board, agentId, id);
      }
    },
  };
}
