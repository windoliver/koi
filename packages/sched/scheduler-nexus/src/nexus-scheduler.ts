import type { KoiError, Result, ScheduleStore, TaskQueueBackend, TaskStore } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusTaskQueue } from "./nexus-queue.js";
import { createNexusScheduleStore } from "./nexus-schedule-store.js";
import { createNexusTaskStore } from "./nexus-task-store.js";
import { DEFAULT_TIMEOUT_MS, type NexusSchedulerConfig } from "./scheduler-config.js";

export interface NexusSchedulerBackends {
  readonly taskStore: TaskStore;
  readonly scheduleStore: ScheduleStore;
  readonly queueBackend: TaskQueueBackend;
}

export function createNexusSchedulerBackends(config: NexusSchedulerConfig): NexusSchedulerBackends {
  const transport = createSchedulerTransport(config);
  return {
    taskStore: createNexusTaskStore(transport),
    scheduleStore: createNexusScheduleStore(transport),
    queueBackend: createNexusTaskQueue(config),
  };
}

function httpError(response: Response, method: string): KoiError {
  return {
    code: response.status === 404 ? "NOT_FOUND" : "EXTERNAL",
    message: `HTTP ${String(response.status)} during ${method}`,
    retryable: response.status >= 500,
    context: { httpStatus: response.status, method },
  };
}

function rpcError(
  err: { readonly code?: number; readonly message?: string },
  method: string,
): KoiError {
  return {
    code: err.code === -32000 ? "NOT_FOUND" : "EXTERNAL",
    message: err.message ?? `RPC error calling ${method}`,
    retryable: false,
    context: { method, rpcCode: err.code },
  };
}

function transportError(error: unknown, method: string): KoiError {
  return {
    code: "TIMEOUT",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    cause: error,
    context: { method },
  };
}

function createSchedulerTransport(config: NexusSchedulerConfig): NexusTransport {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
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
      if (!response.ok) return { ok: false, error: httpError(response, method) };
      const payload = (await response.json()) as {
        readonly result?: T;
        readonly error?: { readonly code?: number; readonly message?: string };
      };
      if (payload.error !== undefined) return { ok: false, error: rpcError(payload.error, method) };
      return { ok: true, value: payload.result as T };
    } catch (error: unknown) {
      return { ok: false, error: transportError(error, method) };
    }
  }

  return { call, close: () => {} };
}
