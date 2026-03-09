/**
 * createNexusTaskQueue — Nexus Astraea-backed priority queue.
 *
 * Thin HTTP client implementing TaskQueueBackend that delegates
 * priority dispatch to Nexus while Koi retains cron/timing/retry.
 *
 * Supports optional distributed claim/ack/nack/tick semantics when
 * configured with NexusSchedulerConfig (visibility timeout).
 *
 * Follows the pay-nexus/store-nexus pattern: injectable fetch,
 * AbortSignal.timeout, error mapping for consistent KoiError codes.
 */

import type {
  EngineInput,
  KoiError,
  ScheduledTask,
  ScheduleId,
  TaskId,
  TaskQueueBackend,
  TaskStatus,
} from "@koi/core";
import { taskId } from "@koi/core";
import { isKoiError } from "@koi/errors";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient, mapHttpError } from "@koi/nexus-client";
import type { NexusTaskQueueConfig } from "./config.js";
import type { NexusSchedulerConfig } from "./scheduler-config.js";
import { DEFAULT_TIMEOUT_MS, DEFAULT_VISIBILITY_TIMEOUT_MS } from "./scheduler-config.js";

// ---------------------------------------------------------------------------
// Valid task statuses (for response validation)
// ---------------------------------------------------------------------------

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "dead_letter",
]);

// ---------------------------------------------------------------------------
// Wire types (snake_case from Nexus Astraea API)
// ---------------------------------------------------------------------------

interface ApiEnqueueResponse {
  readonly id: string;
}

interface ApiCancelResponse {
  readonly cancelled: boolean;
}

interface ApiStatusResponse {
  readonly status: string;
}

// ---------------------------------------------------------------------------
// Input serialization — strip non-serializable fields (callHandlers, signal)
// ---------------------------------------------------------------------------

function serializeInput(input: EngineInput): Record<string, unknown> {
  const { callHandlers: _ch, signal: _sig, correlationIds: _cid, ...rest } = input;
  return rest;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusTaskQueue(
  config: NexusTaskQueueConfig | NexusSchedulerConfig,
): TaskQueueBackend {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = config.baseUrl;

  async function request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };

    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e: unknown) {
      throw new Error(`Nexus scheduler request failed: ${method} ${path}`, { cause: e });
    }

    if (!response.ok) {
      let errorMessage = `HTTP ${String(response.status)}`;
      try {
        const errorBody = (await response.json()) as { readonly message?: string };
        if (errorBody.message) {
          errorMessage = errorBody.message;
        }
      } catch {
        // Error body not JSON — fall through to status code message
      }
      const koiError = mapHttpError(response.status, errorMessage);
      throw new Error(errorMessage, { cause: koiError });
    }

    const text = await response.text();
    if (text === "") {
      throw new Error(`Empty response from Nexus scheduler: ${method} ${path}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch (e: unknown) {
      throw new Error(`Failed to parse Nexus scheduler response: ${method} ${path}`, { cause: e });
    }
  }

  return {
    async enqueue(task: ScheduledTask, idempotencyKey?: string): Promise<TaskId> {
      const result = await request<ApiEnqueueResponse>("POST", "/api/v2/scheduler/submit", {
        task_id: task.id,
        agent_id: task.agentId,
        input: serializeInput(task.input),
        priority: task.priority,
        mode: task.mode,
        created_at: task.createdAt,
        max_retries: task.maxRetries,
        metadata: task.metadata,
        ...(task.scheduledAt !== undefined ? { scheduled_at: task.scheduledAt } : {}),
        ...(task.timeoutMs !== undefined ? { timeout_ms: task.timeoutMs } : {}),
        ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
      });
      return taskId(result.id);
    },

    async cancel(id: TaskId): Promise<boolean> {
      const result = await request<ApiCancelResponse>(
        "POST",
        `/api/v2/scheduler/task/${id}/cancel`,
      );
      return result.cancelled;
    },

    async status(id: TaskId): Promise<TaskStatus | undefined> {
      try {
        const result = await request<ApiStatusResponse>("GET", `/api/v2/scheduler/task/${id}`);
        if (!VALID_TASK_STATUSES.has(result.status)) {
          throw new Error(`Nexus returned unknown task status: "${result.status}" for task ${id}`);
        }
        return result.status as TaskStatus;
      } catch (e: unknown) {
        // 404 → task not found, return undefined
        if (e instanceof Error && isKoiError(e.cause) && e.cause.code === "NOT_FOUND") {
          return undefined;
        }
        throw e;
      }
    },

    // -----------------------------------------------------------------------
    // Distributed claim semantics (via JSON-RPC)
    // -----------------------------------------------------------------------

    ...createDistributedMethods(config),

    [Symbol.asyncDispose]: async (): Promise<void> => {
      // No persistent connections to clean up
    },
  };
}

// ---------------------------------------------------------------------------
// Distributed RPC wire types
// ---------------------------------------------------------------------------

interface ApiClaimResponse {
  readonly tasks: readonly ApiClaimedTask[];
}

interface ApiClaimedTask {
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
  readonly last_error?: KoiError | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

interface ApiAckResponse {
  readonly ok: boolean;
}

interface ApiNackResponse {
  readonly ok: boolean;
}

interface ApiTickResponse {
  readonly claimed: boolean;
}

// ---------------------------------------------------------------------------
// Map wire task to domain ScheduledTask
// ---------------------------------------------------------------------------

function mapClaimedTask(wire: ApiClaimedTask): ScheduledTask {
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
    lastError: wire.last_error,
    metadata: wire.metadata,
  };
}

// ---------------------------------------------------------------------------
// RPC result unwrapper
// ---------------------------------------------------------------------------

function unwrapRpc<T>(result: {
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
// Create distributed methods (claim/ack/nack/tick) via JSON-RPC
// ---------------------------------------------------------------------------

function createDistributedMethods(
  config: NexusTaskQueueConfig | NexusSchedulerConfig,
): Pick<TaskQueueBackend, "claim" | "ack" | "nack" | "tick"> {
  const visibilityTimeoutMs =
    "visibilityTimeoutMs" in config
      ? ((config as NexusSchedulerConfig).visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS)
      : DEFAULT_VISIBILITY_TIMEOUT_MS;

  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  return {
    async claim(nodeId: string, limit?: number): Promise<readonly ScheduledTask[]> {
      const result = unwrapRpc<ApiClaimResponse>(
        await client.rpc("scheduler.claim", {
          node_id: nodeId,
          ...(limit !== undefined ? { limit } : {}),
          visibility_timeout_ms: visibilityTimeoutMs,
        }),
      );
      return result.tasks.map(mapClaimedTask);
    },

    async ack(id: TaskId, result?: unknown): Promise<boolean> {
      const response = unwrapRpc<ApiAckResponse>(
        await client.rpc("scheduler.ack", {
          task_id: id,
          ...(result !== undefined ? { result } : {}),
        }),
      );
      return response.ok;
    },

    async nack(id: TaskId, reason?: string): Promise<boolean> {
      const response = unwrapRpc<ApiNackResponse>(
        await client.rpc("scheduler.nack", {
          task_id: id,
          ...(reason !== undefined ? { reason } : {}),
        }),
      );
      return response.ok;
    },

    async tick(sid: ScheduleId, nodeId: string): Promise<boolean> {
      const response = unwrapRpc<ApiTickResponse>(
        await client.rpc("scheduler.tick", {
          schedule_id: sid,
          node_id: nodeId,
        }),
      );
      return response.claimed;
    },
  };
}
