import type { KoiError, ProcessState, Result, WorkerEvent, WorkerId } from "@koi/core";

export interface RemoteStatusResponse {
  readonly alive: boolean;
}

export interface RemoteSpawnPayload {
  readonly startedAt: number;
  readonly pid: number | undefined;
  readonly cursor: unknown;
  readonly alive: boolean;
  readonly events: readonly WorkerEvent[];
}

export interface RemoteEventsPayload {
  readonly nextCursor: unknown;
  readonly alive: boolean | undefined;
  readonly events: readonly WorkerEvent[];
}

const PROCESS_STATES: ReadonlySet<ProcessState> = new Set([
  "created",
  "running",
  "waiting",
  "suspended",
  "idle",
  "terminated",
]);

export function parseProbeResponse(value: unknown): {
  readonly available: boolean;
  readonly heartbeat: boolean;
} {
  if (typeof value === "boolean") return { available: value, heartbeat: false };
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      available: record.available === true,
      heartbeat: record.supportsHeartbeat === true || record.heartbeat === true,
    };
  }
  return { available: false, heartbeat: false };
}

export function parseSpawnResponse(
  value: unknown,
  fallbackStartedAt: number,
  expectedWorkerId: WorkerId,
): Result<RemoteSpawnPayload, KoiError> {
  if (value === null || typeof value !== "object") {
    return invalidRemoteResponse("workers.spawn returned a non-object payload");
  }
  const record = value as Record<string, unknown>;
  const startedAt =
    typeof record.startedAt === "number" && Number.isFinite(record.startedAt)
      ? record.startedAt
      : fallbackStartedAt;
  const pid =
    typeof record.pid === "number" && Number.isFinite(record.pid) ? record.pid : undefined;
  const events = parseRemoteEventsArray(record.events, expectedWorkerId);
  if (!events.ok) return events;
  return {
    ok: true,
    value: {
      startedAt,
      pid,
      cursor: "cursor" in record ? record.cursor : undefined,
      alive: record.alive !== false,
      events: events.value,
    },
  };
}

export function parseStatusResponse(value: unknown): Result<RemoteStatusResponse, KoiError> {
  if (value === null || typeof value !== "object") {
    return invalidRemoteResponse("workers.status returned a non-object payload");
  }
  const alive = (value as Record<string, unknown>).alive;
  if (typeof alive !== "boolean") {
    return invalidRemoteResponse("workers.status returned a payload without boolean alive");
  }
  return { ok: true, value: { alive } };
}

export function parseEventsResponse(
  value: unknown,
  expectedWorkerId: WorkerId,
): Result<RemoteEventsPayload, KoiError> {
  if (value === null || typeof value !== "object") {
    return invalidRemoteResponse("workers.events returned a non-object payload");
  }
  const record = value as Record<string, unknown>;
  const events = parseRemoteEventsArray(record.events, expectedWorkerId);
  if (!events.ok) return events;
  const alive = typeof record.alive === "boolean" ? record.alive : undefined;
  return {
    ok: true,
    value: {
      nextCursor: "nextCursor" in record ? record.nextCursor : record.cursor,
      alive,
      events: events.value,
    },
  };
}

function parseRemoteEventsArray(
  value: unknown,
  expectedWorkerId?: WorkerId,
): Result<readonly WorkerEvent[], KoiError> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value))
    return invalidRemoteResponse("remote worker events payload must be an array");
  const events: WorkerEvent[] = [];
  for (const item of value) {
    const parsed = parseWorkerEvent(item, expectedWorkerId);
    if (!parsed.ok) return parsed;
    if (parsed.value !== null) events.push(parsed.value);
  }
  return { ok: true, value: events };
}

function parseWorkerEvent(
  value: unknown,
  expectedWorkerId: WorkerId | undefined,
): Result<WorkerEvent | null, KoiError> {
  if (value === null || typeof value !== "object") {
    return invalidRemoteResponse("remote worker event must be an object");
  }
  const record = value as Record<string, unknown>;
  const worker = record.workerId;
  const at = record.at;
  const kind = record.kind;
  if (
    typeof worker !== "string" ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    typeof kind !== "string"
  ) {
    return invalidRemoteResponse("remote worker event is missing kind/workerId/at");
  }
  if (expectedWorkerId !== undefined && worker !== expectedWorkerId) {
    return { ok: true, value: null };
  }
  if (kind === "started") return parseStartedEvent(record, worker, at);
  if (kind === "heartbeat") return { ok: true, value: { kind, workerId: worker as WorkerId, at } };
  if (kind === "exited") return parseExitedEvent(record, worker, at);
  if (kind === "crashed") return parseCrashedEvent(record, worker, at);
  return { ok: true, value: null };
}

function parseStartedEvent(
  record: Record<string, unknown>,
  worker: string,
  at: number,
): Result<WorkerEvent, KoiError> {
  const pid =
    typeof record.pid === "number" && Number.isFinite(record.pid) ? record.pid : undefined;
  return {
    ok: true,
    value: {
      kind: "started",
      workerId: worker as WorkerId,
      at,
      ...(pid !== undefined ? { pid } : {}),
    },
  };
}

function parseExitedEvent(
  record: Record<string, unknown>,
  worker: string,
  at: number,
): Result<WorkerEvent, KoiError> {
  if (typeof record.code !== "number" || typeof record.state !== "string") {
    return invalidRemoteResponse("remote exited event is missing code/state");
  }
  if (!PROCESS_STATES.has(record.state as ProcessState)) {
    return invalidRemoteResponse(`remote exited event has unsupported state "${record.state}"`);
  }
  return {
    ok: true,
    value: {
      kind: "exited",
      workerId: worker as WorkerId,
      at,
      code: record.code,
      state: record.state as ProcessState,
    },
  };
}

function parseCrashedEvent(
  record: Record<string, unknown>,
  worker: string,
  at: number,
): Result<WorkerEvent, KoiError> {
  const error = record.error;
  if (
    error === null ||
    typeof error !== "object" ||
    typeof (error as Record<string, unknown>).code !== "string" ||
    typeof (error as Record<string, unknown>).message !== "string" ||
    typeof (error as Record<string, unknown>).retryable !== "boolean"
  ) {
    return invalidRemoteResponse("remote crashed event is missing a valid KoiError payload");
  }
  return {
    ok: true,
    value: {
      kind: "crashed",
      workerId: worker as WorkerId,
      at,
      error: {
        code: (error as Record<string, unknown>).code as KoiError["code"],
        message: (error as Record<string, unknown>).message as string,
        retryable: (error as Record<string, unknown>).retryable as boolean,
      },
    },
  };
}

function invalidRemoteResponse<T>(message: string): Result<T, KoiError> {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: false },
  };
}

export function isTerminalEvent(event: WorkerEvent): boolean {
  return event.kind === "exited" || event.kind === "crashed";
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
