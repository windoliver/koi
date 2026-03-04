/**
 * Nexus-backed TaskStore implementation via JSON-RPC.
 *
 * Delegates task persistence to a remote Nexus server, enabling
 * distributed task storage across nodes.
 */

import type { ScheduledTask, TaskFilter, TaskId, TaskStatus, TaskStore } from "@koi/core";
import { taskId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";

// ---------------------------------------------------------------------------
// Wire types (snake_case from Nexus)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Wire → domain mapping
// ---------------------------------------------------------------------------

function mapApiTask(wire: ApiTask): ScheduledTask {
  return {
    id: taskId(wire.id),
    agentId: wire.agent_id as ScheduledTask["agentId"],
    input: wire.input as ScheduledTask["input"],
    mode: wire.mode as ScheduledTask["mode"],
    priority: wire.priority,
    status: wire.status as ScheduledTask["status"],
    createdAt: wire.created_at,
    scheduledAt: wire.scheduled_at,
    startedAt: wire.started_at,
    completedAt: wire.completed_at,
    retries: wire.retries,
    maxRetries: wire.max_retries,
    timeoutMs: wire.timeout_ms,
    lastError: wire.last_error as ScheduledTask["lastError"],
    metadata: wire.metadata as ScheduledTask["metadata"],
  };
}

/** Serialize a ScheduledTask to snake_case wire format. */
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

// ---------------------------------------------------------------------------
// RPC result unwrapper
// ---------------------------------------------------------------------------

function unwrap<T>(result: {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: unknown;
}): T {
  if (!result.ok) {
    const err = result.error as { readonly message?: string } | undefined;
    throw new Error(err?.message ?? "Nexus RPC failed", { cause: result.error });
  }
  return (result as { readonly value: T }).value;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed TaskStore using JSON-RPC. */
export function createNexusTaskStore(client: NexusClient): TaskStore {
  return {
    async save(task: ScheduledTask): Promise<void> {
      unwrap(await client.rpc("scheduler.task.save", taskToWire(task)));
    },

    async load(id: TaskId): Promise<ScheduledTask | undefined> {
      const result = unwrap<ApiLoadResponse>(await client.rpc("scheduler.task.load", { id }));
      return result.task !== null ? mapApiTask(result.task) : undefined;
    },

    async remove(id: TaskId): Promise<void> {
      unwrap(await client.rpc("scheduler.task.remove", { id }));
    },

    async updateStatus(
      id: TaskId,
      status: TaskStatus,
      patch?: Partial<Pick<ScheduledTask, "startedAt" | "completedAt" | "lastError" | "retries">>,
    ): Promise<void> {
      unwrap(
        await client.rpc("scheduler.task.updateStatus", {
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
        await client.rpc("scheduler.task.query", {
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
        await client.rpc("scheduler.task.query", { status: "pending" }),
      );
      return result.tasks.map(mapApiTask);
    },

    [Symbol.asyncDispose]: async (): Promise<void> => {
      // No persistent connections to clean up
    },
  };
}
