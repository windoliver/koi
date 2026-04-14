/**
 * Platform tool builders — real Koi Tools exposing platform capabilities.
 *
 * Each tool is built via buildTool() from @koi/tools-core so it gets
 * proper ToolDescriptor, ToolPolicy, and origin. When wired through
 * the runtime, these tools pass through the existing safety envelope
 * (permissions middleware, exfiltration guard).
 *
 * Security invariants:
 * - koi_send_message: `from` always = callerId, `kind` always = "event"
 * - koi_update_task: uses atomic owned variants (completeOwnedTask, failOwnedTask)
 * - koi_list_agents: passes VisibilityContext with callerId
 * - All projections exclude sensitive internal fields
 */

import type {
  AgentId,
  AgentRegistry,
  JsonObject,
  KoiError,
  MailboxComponent,
  ManagedTaskBoard,
  Result,
  Task,
  TaskItemId,
  Tool,
  VisibilityContext,
} from "@koi/core";
import { agentId } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import type { PlatformCapabilities } from "./config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
/** Maximum characters for task output/error payloads. */
const MAX_PAYLOAD_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(1, n), MAX_LIST_LIMIT);
}

/** Validate an optional enum field. Returns undefined if not provided, throws if invalid. */
function validateEnum(raw: unknown, field: string, allowed: readonly string[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    throw new Error(`Invalid ${field}: must be one of ${allowed.join(", ")}`);
  }
  return raw;
}

function unwrapResult<T>(result: Result<T, KoiError>, action: string): T {
  if (!result.ok) {
    throw new Error(`${action}: ${result.error.message}`);
  }
  return result.value;
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return raw;
}

function taskItemId(raw: unknown): TaskItemId {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("taskId is required and must be a non-empty string");
  }
  return raw as TaskItemId;
}

/** Lean task projection — excludes error details, metadata, version internals. */
function projectTask(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    assignedTo: t.assignedTo ?? null,
    dependencies: t.dependencies,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Tool builders
// ---------------------------------------------------------------------------

function createSendMessageTool(callerId: AgentId, mailbox: MailboxComponent): Tool {
  const result = buildTool({
    name: "koi_send_message",
    description: "Send an event message to a Koi agent's mailbox",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target agent ID" },
        type: { type: "string", description: "Message type (e.g. 'status-update')" },
        payload: { type: "object", description: "Message payload" },
      },
      required: ["to", "type", "payload"],
    },
    origin: "primordial",
    sandbox: false,
    async execute(args: JsonObject): Promise<unknown> {
      const rawPayload = args.payload;
      if (
        rawPayload !== undefined &&
        (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload))
      ) {
        throw new Error("payload must be a JSON object");
      }
      // Enforce serialized size limit on payload
      const serialized = JSON.stringify(rawPayload ?? {});
      if (serialized.length > MAX_PAYLOAD_CHARS) {
        throw new Error(`payload exceeds maximum size (${MAX_PAYLOAD_CHARS} chars)`);
      }
      const to = requireString(args.to, "to");
      const type = requireString(args.type, "type");
      const sendResult = await mailbox.send({
        from: callerId,
        to: agentId(to),
        kind: "event",
        type,
        payload: (rawPayload ?? {}) as JsonObject,
      });
      const msg = unwrapResult(sendResult, "koi_send_message");
      return { id: msg.id, createdAt: msg.createdAt };
    },
  });
  if (!result.ok) throw new Error(`Failed to build koi_send_message: ${result.error.message}`);
  return result.value;
}

function createListMessagesTool(mailbox: MailboxComponent): Tool {
  const result = buildTool({
    name: "koi_list_messages",
    description: "List messages in the agent's mailbox with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["request", "response", "event", "cancel"],
          description: "Filter by message kind",
        },
        type: { type: "string", description: "Filter by message type" },
        from: { type: "string", description: "Filter by sender agent ID" },
        limit: {
          type: "number",
          description: "Max messages to return (default 50, max 100)",
        },
      },
    },
    origin: "primordial",
    sandbox: false,
    async execute(args: JsonObject): Promise<unknown> {
      const limit = clampLimit(args.limit);
      const kind = validateEnum(args.kind, "kind", ["request", "response", "event", "cancel"]);
      const filter: Record<string, unknown> = { limit };
      if (kind !== undefined) filter.kind = kind;
      if (args.type !== undefined) filter.type = requireString(args.type, "type");
      if (args.from !== undefined) filter.from = requireString(args.from, "from");

      const messages = await mailbox.list(filter as Parameters<MailboxComponent["list"]>[0]);
      return messages.map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        kind: m.kind,
        type: m.type,
        createdAt: m.createdAt,
      }));
    },
  });
  if (!result.ok) throw new Error(`Failed to build koi_list_messages: ${result.error.message}`);
  return result.value;
}

function createListTasksTool(taskBoard: ManagedTaskBoard): Tool {
  const result = buildTool({
    name: "koi_list_tasks",
    description: "List tasks on the task board with optional status filter",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "failed", "killed"],
          description: "Filter by task status",
        },
        limit: {
          type: "number",
          description: "Max tasks to return (default 50, max 100)",
        },
      },
    },
    origin: "primordial",
    sandbox: false,
    async execute(args: JsonObject): Promise<unknown> {
      const limit = clampLimit(args.limit);
      const board = taskBoard.snapshot();
      const status = validateEnum(args.status, "status", [
        "pending",
        "in_progress",
        "completed",
        "failed",
        "killed",
      ]);

      const statusMethodMap: Record<string, () => readonly Task[]> = {
        pending: () => board.pending(),
        in_progress: () => board.inProgress(),
        completed: () => board.all().filter((t) => t.status === "completed"),
        failed: () => board.failed(),
        killed: () => board.killed(),
      };

      const tasks =
        status !== undefined && status in statusMethodMap
          ? (statusMethodMap[status]?.() ?? board.all())
          : board.all();

      return tasks.slice(0, limit).map(projectTask);
    },
  });
  if (!result.ok) throw new Error(`Failed to build koi_list_tasks: ${result.error.message}`);
  return result.value;
}

function createGetTaskTool(taskBoard: ManagedTaskBoard): Tool {
  const result = buildTool({
    name: "koi_get_task",
    description: "Get full details of a task by ID",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task item ID" },
      },
      required: ["taskId"],
    },
    origin: "primordial",
    sandbox: false,
    async execute(args: JsonObject): Promise<unknown> {
      const id = taskItemId(args.taskId);
      const task = taskBoard.snapshot().get(id);
      if (task === undefined) {
        throw new Error("Task not found");
      }
      // Explicit allowlist — excludes metadata, activeForm, error internals
      return {
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        assignedTo: task.assignedTo ?? null,
        dependencies: task.dependencies,
        retries: task.retries,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
    },
  });
  if (!result.ok) throw new Error(`Failed to build koi_get_task: ${result.error.message}`);
  return result.value;
}

function createUpdateTaskTool(callerId: AgentId, taskBoard: ManagedTaskBoard): Tool {
  const result = buildTool({
    name: "koi_update_task",
    description: "Update a task's status: start (assigns to caller), complete, or fail",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task item ID" },
        action: {
          type: "string",
          enum: ["start", "complete", "fail"],
          description: "Action to perform",
        },
        output: {
          type: "string",
          description:
            "Task output text for 'complete' action. Defaults to the task subject if omitted.",
        },
        error: {
          type: "string",
          description: "Required for 'fail' action — error description",
        },
      },
      required: ["taskId", "action"],
    },
    origin: "primordial",
    sandbox: false,
    async execute(args: JsonObject): Promise<unknown> {
      const id = taskItemId(args.taskId);
      const action = requireString(args.action, "action");

      switch (action) {
        case "start": {
          unwrapResult(await taskBoard.startTask(id, callerId), "start task");
          return { status: "started", taskId: id, assignedTo: callerId };
        }
        case "complete": {
          if (!taskBoard.hasResultPersistence()) {
            throw new Error("Task completion requires durable result storage");
          }
          // Compute duration from task timestamps when available
          const task = taskBoard.snapshot().get(id);
          // Reject non-string, non-undefined output (caller bug)
          if (args.output !== undefined && typeof args.output !== "string") {
            throw new Error("output must be a string");
          }
          // Default output to task subject when omitted (#1785)
          const rawOutput =
            typeof args.output === "string" && args.output.trim() !== ""
              ? args.output
              : `Completed: ${task?.subject ?? String(id)}`;
          if (rawOutput.length > MAX_PAYLOAD_CHARS) {
            throw new Error(`Output exceeds maximum size (${MAX_PAYLOAD_CHARS} chars)`);
          }
          const output = rawOutput;
          const durationMs = task !== undefined ? Math.max(0, Date.now() - task.updatedAt) : 0;
          unwrapResult(
            await taskBoard.completeOwnedTask(id, callerId, {
              taskId: id,
              output,
              durationMs,
            }),
            "complete task",
          );
          return { status: "completed", taskId: id };
        }
        case "fail": {
          const rawError = requireString(args.error, "error");
          if (rawError.length > MAX_PAYLOAD_CHARS) {
            throw new Error(`Error message exceeds maximum size (${MAX_PAYLOAD_CHARS} chars)`);
          }
          const errorMsg = rawError;
          const koiError: KoiError = {
            code: "INTERNAL",
            message: errorMsg,
            retryable: false,
          };
          unwrapResult(await taskBoard.failOwnedTask(id, callerId, koiError), "fail task");
          return { status: "failed", taskId: id };
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  });
  if (!result.ok) throw new Error(`Failed to build koi_update_task: ${result.error.message}`);
  return result.value;
}

function createTaskOutputTool(callerId: AgentId, taskBoard: ManagedTaskBoard): Tool {
  const result = buildTool({
    name: "koi_task_output",
    description: "Get the output of a completed task",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task item ID" },
      },
      required: ["taskId"],
    },
    origin: "primordial",
    sandbox: false,
    async execute(args: JsonObject): Promise<unknown> {
      const id = taskItemId(args.taskId);
      // Single snapshot for consistent authorization + read
      const board = taskBoard.snapshot();
      const task = board.get(id);
      if (task !== undefined && task.assignedTo !== undefined && task.assignedTo !== callerId) {
        throw new Error("Not authorized to read this task's output");
      }
      const taskResult = board.result(id);
      if (taskResult === undefined) {
        throw new Error("No completed result for this task");
      }
      return {
        taskId: taskResult.taskId,
        output: taskResult.output,
        durationMs: taskResult.durationMs,
        warnings: taskResult.warnings ?? [],
      };
    },
  });
  if (!result.ok) throw new Error(`Failed to build koi_task_output: ${result.error.message}`);
  return result.value;
}

function createListAgentsTool(callerId: AgentId, registry: AgentRegistry): Tool {
  const result = buildTool({
    name: "koi_list_agents",
    description: "List registered agents in the Koi runtime",
    inputSchema: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          enum: ["created", "running", "waiting", "suspended", "idle", "terminated"],
          description: "Filter by agent lifecycle phase",
        },
      },
    },
    origin: "primordial",
    sandbox: false,
    async execute(args: JsonObject): Promise<unknown> {
      const visibility: VisibilityContext = { callerId };
      const validPhases = [
        "created",
        "running",
        "waiting",
        "suspended",
        "idle",
        "terminated",
      ] as const;
      const phase = validateEnum(args.phase, "phase", validPhases);
      const filter =
        phase !== undefined ? { phase: phase as (typeof validPhases)[number] } : undefined;

      const entries = await registry.list(filter, visibility);
      return entries.map((e) => ({
        agentId: e.agentId,
        agentType: e.agentType,
        phase: e.status.phase,
        parentId: e.parentId ?? null,
        registeredAt: e.registeredAt,
      }));
    },
  });
  if (!result.ok) throw new Error(`Failed to build koi_list_agents: ${result.error.message}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build platform tools based on provided capabilities.
 * Only tools for available subsystem handles are created.
 */
export function createPlatformTools(capabilities: PlatformCapabilities): readonly Tool[] {
  const tools: Tool[] = [];
  const { callerId, mailbox, taskBoard, registry } = capabilities;

  if (mailbox !== undefined) {
    tools.push(createSendMessageTool(callerId, mailbox));
    tools.push(createListMessagesTool(mailbox));
  }

  if (taskBoard !== undefined) {
    tools.push(createListTasksTool(taskBoard));
    tools.push(createGetTaskTool(taskBoard));
    tools.push(createUpdateTaskTool(callerId, taskBoard));
    tools.push(createTaskOutputTool(callerId, taskBoard));
  }

  if (registry !== undefined) {
    tools.push(createListAgentsTool(callerId, registry));
  }

  return tools;
}
