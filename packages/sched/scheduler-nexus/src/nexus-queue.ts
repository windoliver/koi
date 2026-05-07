import type { EngineInput, KoiError, Result, ScheduledTask, TaskQueueBackend } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import type { NexusTaskQueueConfig } from "./config.js";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  type NexusSchedulerConfig,
} from "./scheduler-config.js";

interface ApiEnqueueResponse {
  readonly id: string;
}

interface ApiCancelResponse {
  readonly cancelled: boolean;
}

interface ApiStatusResponse {
  readonly status: string;
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

interface ApiClaimResponse {
  readonly tasks: readonly ApiClaimedTask[];
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

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "dead_letter",
]);

export function createNexusTaskQueue(
  config: NexusTaskQueueConfig | NexusSchedulerConfig,
): TaskQueueBackend {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = createSchedulerTransport(config);

  return {
    async enqueue(task: ScheduledTask, idempotencyKey?: string): Promise<ScheduledTask["id"]> {
      const response = await request<ApiEnqueueResponse>(
        config,
        "POST",
        "/api/v2/scheduler/submit",
        {
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
        },
        fetchFn,
        timeoutMs,
      );
      return response.id as ScheduledTask["id"];
    },

    async cancel(id: ScheduledTask["id"]): Promise<boolean> {
      const response = await request<ApiCancelResponse>(
        config,
        "POST",
        `/api/v2/scheduler/task/${String(id)}/cancel`,
        undefined,
        fetchFn,
        timeoutMs,
      );
      return response.cancelled;
    },

    async status(id: ScheduledTask["id"]): Promise<ScheduledTask["status"] | undefined> {
      try {
        const response = await request<ApiStatusResponse>(
          config,
          "GET",
          `/api/v2/scheduler/task/${String(id)}`,
          undefined,
          fetchFn,
          timeoutMs,
        );
        if (!VALID_TASK_STATUSES.has(response.status)) {
          throw new Error(
            `Nexus returned unknown task status: "${response.status}" for task ${String(id)}`,
          );
        }
        return response.status as ScheduledTask["status"];
      } catch (error) {
        if (
          error instanceof Error &&
          typeof error.cause === "object" &&
          error.cause !== null &&
          "code" in error.cause &&
          (error.cause as { code?: string }).code === "NOT_FOUND"
        ) {
          return undefined;
        }
        throw error;
      }
    },

    async claim(nodeId: string, limit?: number): Promise<readonly ScheduledTask[]> {
      const visibilityTimeoutMs =
        "visibilityTimeoutMs" in config
          ? (config.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS)
          : DEFAULT_VISIBILITY_TIMEOUT_MS;
      const response = unwrap<ApiClaimResponse>(
        await transport.call("scheduler.claim", {
          node_id: nodeId,
          ...(limit !== undefined ? { limit } : {}),
          visibility_timeout_ms: visibilityTimeoutMs,
        }),
      );
      return response.tasks.map(mapClaimedTask);
    },

    async ack(id: ScheduledTask["id"], result?: unknown): Promise<boolean> {
      const response = unwrap<ApiAckResponse>(
        await transport.call("scheduler.ack", {
          task_id: id,
          ...(result !== undefined ? { result } : {}),
        }),
      );
      return response.ok;
    },

    async nack(id: ScheduledTask["id"], reason?: string): Promise<boolean> {
      const response = unwrap<ApiNackResponse>(
        await transport.call("scheduler.nack", {
          task_id: id,
          ...(reason !== undefined ? { reason } : {}),
        }),
      );
      return response.ok;
    },

    async tick(scheduleId: string, nodeId: string): Promise<boolean> {
      const response = unwrap<ApiTickResponse>(
        await transport.call("scheduler.tick", {
          schedule_id: scheduleId,
          node_id: nodeId,
        }),
      );
      return response.claimed;
    },

    [Symbol.asyncDispose]: async (): Promise<void> => {
      transport.close();
    },
  };
}

function serializeInput(input: EngineInput): Record<string, unknown> {
  const {
    callHandlers: _callHandlers,
    signal: _signal,
    correlationIds: _correlationIds,
    ...rest
  } = input;
  return rest;
}

function mapClaimedTask(task: ApiClaimedTask): ScheduledTask {
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
    lastError: task.last_error,
    metadata: task.metadata,
  };
}

async function request<T>(
  config: NexusTaskQueueConfig,
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(`${config.baseUrl}${path}`, {
      method,
      headers: {
        ...(config.apiKey !== undefined ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Nexus scheduler request failed: ${method} ${path}`, { cause: error });
  }

  if (!response.ok) {
    const cause = httpError(response.status, response.statusText);
    let message = `HTTP ${String(response.status)}`;
    try {
      const payload = (await response.json()) as { readonly message?: string };
      if (payload.message !== undefined) message = payload.message;
    } catch {}
    throw new Error(message, { cause });
  }

  const text = await response.text();
  if (text === "") {
    throw new Error(`Empty response from Nexus scheduler: ${method} ${path}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Failed to parse Nexus scheduler response: ${method} ${path}`, {
      cause: error,
    });
  }
}

function rpcErrorResult<T>(
  err: { readonly code?: number; readonly message?: string },
  method: string,
): Result<T, KoiError> {
  return {
    ok: false,
    error: {
      code: err.code === -32000 ? "NOT_FOUND" : "EXTERNAL",
      message: err.message ?? `RPC error calling ${method}`,
      retryable: false,
      context: { method, rpcCode: err.code },
    },
  };
}

function transportErrorResult<T>(error: unknown, method: string): Result<T, KoiError> {
  return {
    ok: false,
    error: {
      code: "TIMEOUT",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      cause: error,
      context: { method },
    },
  };
}

function createSchedulerTransport(config: NexusTaskQueueConfig): NexusTransport {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    call: async <T>(method: string, params: Record<string, unknown>) => {
      try {
        const response = await fetchFn(`${config.baseUrl}/api/nfs/${encodeURIComponent(method)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey !== undefined ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return {
            ok: false,
            error: httpError(response.status, response.statusText),
          } satisfies Result<T, KoiError>;
        }
        const payload = (await response.json()) as {
          readonly result?: T;
          readonly error?: { readonly code?: number; readonly message?: string };
        };
        if (payload.error !== undefined) return rpcErrorResult<T>(payload.error, method);
        return { ok: true, value: payload.result as T } satisfies Result<T, KoiError>;
      } catch (error: unknown) {
        return transportErrorResult<T>(error, method);
      }
    },
    close: () => {},
  };
}

function httpError(status: number, statusText: string): KoiError {
  if (status === 401 || status === 403) {
    return {
      code: "PERMISSION",
      message: `HTTP ${String(status)} during scheduler request`,
      retryable: false,
      context: { httpStatus: status, statusText },
    };
  }
  if (status === 404) {
    return {
      code: "NOT_FOUND",
      message: `HTTP 404 during scheduler request`,
      retryable: false,
      context: { httpStatus: status, statusText },
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMIT",
      message: `HTTP 429 during scheduler request`,
      retryable: true,
      context: { httpStatus: status, statusText },
    };
  }
  if (status >= 500) {
    return {
      code: "EXTERNAL",
      message: `HTTP ${String(status)} during scheduler request`,
      retryable: true,
      context: { httpStatus: status, statusText },
    };
  }
  return {
    code: "EXTERNAL",
    message: `HTTP ${String(status)} during scheduler request`,
    retryable: false,
    context: { httpStatus: status, statusText },
  };
}

function unwrap<T>(result: Result<T, KoiError>): T {
  if (!result.ok) {
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value;
}
