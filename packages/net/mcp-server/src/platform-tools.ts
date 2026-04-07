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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(1, Math.floor(n)), MAX_LIST_LIMIT);
}

function unwrapResult<T>(result: Result<T, KoiError>, action: string): T {
  if (!result.ok) {
    throw new Error(`${action}: ${result.error.message}`);
  }
  return result.value;
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
      const sendResult = await mailbox.send({
        from: callerId,
        to: agentId(String(args.to)),
        kind: "event",
        type: String(args.type),
        payload: (args.payload ?? {}) as JsonObject,
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
      const filter: Record<string, unknown> = { limit };
      if (args.kind !== undefined) filter.kind = String(args.kind);
      if (args.type !== undefined) filter.type = String(args.type);
      if (args.from !== undefined) filter.from = String(args.from);

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
      const status = args.status as string | undefined;

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
        return { error: "NOT_FOUND", message: `Task ${id} not found` };
      }
      return {
        id: task.id,
        subject: task.subject,
        description: task.description,
        status: task.status,
        assignedTo: task.assignedTo ?? null,
        dependencies: task.dependencies,
        activeForm: task.activeForm ?? null,
        retries: task.retries,
        metadata: task.metadata ?? {},
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
          description: "Required for 'complete' action — task output text",
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
      const action = String(args.action);

      switch (action) {
        case "start": {
          unwrapResult(await taskBoard.startTask(id, callerId), "start task");
          return { status: "started", taskId: id, assignedTo: callerId };
        }
        case "complete": {
          const output = typeof args.output === "string" ? args.output : "";
          unwrapResult(
            await taskBoard.completeOwnedTask(id, callerId, {
              taskId: id,
              output,
              durationMs: 0,
            }),
            "complete task",
          );
          return { status: "completed", taskId: id };
        }
        case "fail": {
          const errorMsg = typeof args.error === "string" ? args.error : "Unknown error";
          const koiError: KoiError = {
            code: "INTERNAL",
            message: errorMsg,
            retryable: false,
          };
          unwrapResult(await taskBoard.failOwnedTask(id, callerId, koiError), "fail task");
          return { status: "failed", taskId: id };
        }
        default:
          return { error: "INVALID_ACTION", message: `Unknown action: ${action}` };
      }
    },
  });
  if (!result.ok) throw new Error(`Failed to build koi_update_task: ${result.error.message}`);
  return result.value;
}

function createTaskOutputTool(taskBoard: ManagedTaskBoard): Tool {
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
      const taskResult = taskBoard.snapshot().result(id);
      if (taskResult === undefined) {
        return {
          error: "NOT_FOUND",
          message: `No completed result for task ${id}`,
        };
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
      const filter =
        args.phase !== undefined
          ? {
              phase: String(args.phase) as Parameters<AgentRegistry["list"]>[0] extends infer F
                ? F extends { readonly phase?: infer P }
                  ? P
                  : never
                : never,
            }
          : undefined;

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
    tools.push(createTaskOutputTool(taskBoard));
  }

  if (registry !== undefined) {
    tools.push(createListAgentsTool(callerId, registry));
  }

  return tools;
}
