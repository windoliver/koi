/**
 * createNexusTaskQueue — Nexus Astraea-backed priority queue.
 *
 * Thin HTTP client implementing TaskQueueBackend that delegates
 * priority dispatch to Nexus while Koi retains cron/timing/retry.
 *
 * Follows the pay-nexus/store-nexus pattern: injectable fetch,
 * AbortSignal.timeout, error mapping for consistent KoiError codes.
 */

import type { KoiError, ScheduledTask, TaskId, TaskQueueBackend, TaskStatus } from "@koi/core";
import { RETRYABLE_DEFAULTS, taskId } from "@koi/core";
import type { NexusTaskQueueConfig } from "./config.js";

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
// HTTP error mapping (follows pay-nexus pattern)
// ---------------------------------------------------------------------------

function mapHttpError(status: number, message: string): KoiError {
  if (status === 401 || status === 403) {
    return { code: "PERMISSION", message, retryable: RETRYABLE_DEFAULTS.PERMISSION };
  }
  if (status === 404) {
    return { code: "NOT_FOUND", message, retryable: RETRYABLE_DEFAULTS.NOT_FOUND };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMIT",
      message: message || "Rate limited",
      retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
    };
  }
  if (status >= 500) {
    return { code: "EXTERNAL", message, retryable: true };
  }
  return { code: "EXTERNAL", message: message || `HTTP ${String(status)}`, retryable: false };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

export function createNexusTaskQueue(config: NexusTaskQueueConfig): TaskQueueBackend {
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
        priority: task.priority,
        mode: task.mode,
        metadata: task.metadata,
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
        if (
          e instanceof Error &&
          e.cause !== null &&
          typeof e.cause === "object" &&
          "code" in (e.cause as Record<string, unknown>) &&
          (e.cause as { readonly code: string }).code === "NOT_FOUND"
        ) {
          return undefined;
        }
        throw e;
      }
    },

    [Symbol.asyncDispose]: async (): Promise<void> => {
      // No persistent connections to clean up
    },
  };
}
