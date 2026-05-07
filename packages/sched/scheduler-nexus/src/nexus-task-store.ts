import type {
  KoiError,
  Result,
  ScheduledTask,
  ScheduledTaskStatus,
  TaskFilter,
  TaskStore,
} from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

interface ApiTask {
  readonly id: string;
  readonly agent_id: string;
  readonly input: unknown;
  readonly mode: string;
  readonly priority: number;
  readonly status: string;
  readonly created_at: number;
  readonly scheduled_at?: number | undefined;
  readonly started_at?: number | undefined;
  readonly completed_at?: number | undefined;
  readonly retries: number;
  readonly max_retries: number;
  readonly timeout_ms?: number | undefined;
  readonly last_error?: unknown | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

interface ApiLoadResponse {
  readonly task: ApiTask | null;
}

interface ApiQueryResponse {
  readonly tasks: readonly ApiTask[];
}

export function createNexusTaskStore(transport: NexusTransport): TaskStore {
  return {
    async save(task: ScheduledTask): Promise<void> {
      unwrap(await transport.call("scheduler.task.save", taskToWire(task)));
    },

    async load(id: ScheduledTask["id"]): Promise<ScheduledTask | undefined> {
      const result = unwrap<ApiLoadResponse>(await transport.call("scheduler.task.load", { id }));
      return result.task === null ? undefined : mapApiTask(result.task);
    },

    async remove(id: ScheduledTask["id"]): Promise<void> {
      unwrap(await transport.call("scheduler.task.remove", { id }));
    },

    async updateStatus(
      id: ScheduledTask["id"],
      status: ScheduledTaskStatus,
      patch?: Partial<Pick<ScheduledTask, "startedAt" | "completedAt" | "lastError" | "retries">>,
    ): Promise<void> {
      unwrap(
        await transport.call("scheduler.task.updateStatus", {
          id,
          status,
          ...(patch?.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
          ...(patch?.completedAt !== undefined ? { completed_at: patch.completedAt } : {}),
          ...(patch?.lastError !== undefined ? { last_error: patch.lastError } : {}),
          ...(patch?.retries !== undefined ? { retries: patch.retries } : {}),
        }),
      );
    },

    async query(filter: TaskFilter): Promise<readonly ScheduledTask[]> {
      const result = unwrap<ApiQueryResponse>(
        await transport.call("scheduler.task.query", {
          ...(filter.status !== undefined ? { status: filter.status } : {}),
          ...(filter.agentId !== undefined ? { agent_id: filter.agentId } : {}),
          ...(filter.priority !== undefined ? { priority: filter.priority } : {}),
          ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
        }),
      );
      return result.tasks.map(mapApiTask);
    },

    async loadPending(): Promise<readonly ScheduledTask[]> {
      const result = unwrap<ApiQueryResponse>(
        await transport.call("scheduler.task.query", { status: "pending" }),
      );
      return result.tasks.map(mapApiTask);
    },

    [Symbol.asyncDispose]: async (): Promise<void> => {
      transport.close();
    },
  };
}

function mapApiTask(task: ApiTask): ScheduledTask {
  return {
    id: task.id as ScheduledTask["id"],
    agentId: task.agent_id as ScheduledTask["agentId"],
    input: task.input as ScheduledTask["input"],
    mode: task.mode as ScheduledTask["mode"],
    priority: task.priority,
    status: task.status as ScheduledTask["status"],
    createdAt: task.created_at,
    scheduledAt: task.scheduled_at,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    retries: task.retries,
    maxRetries: task.max_retries,
    timeoutMs: task.timeout_ms,
    lastError: task.last_error as ScheduledTask["lastError"],
    metadata: task.metadata,
  };
}

function taskToWire(task: ScheduledTask): Record<string, unknown> {
  return {
    id: task.id,
    agent_id: task.agentId,
    input: task.input,
    mode: task.mode,
    priority: task.priority,
    status: task.status,
    created_at: task.createdAt,
    scheduled_at: task.scheduledAt,
    started_at: task.startedAt,
    completed_at: task.completedAt,
    retries: task.retries,
    max_retries: task.maxRetries,
    timeout_ms: task.timeoutMs,
    last_error: task.lastError,
    metadata: task.metadata,
  };
}

function unwrap<T>(result: Result<T, KoiError>): T {
  if (!result.ok) {
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value;
}
