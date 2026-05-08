import type {
  KoiError,
  ProcessState,
  Result,
  WorkerBackend,
  WorkerEvent,
  WorkerHandle,
  WorkerId,
  WorkerSpawnRequest,
} from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

interface CreateRemoteBackendOptions {
  readonly transport: NexusTransport;
  readonly methodPrefix?: string;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly pruneGraceMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly supportsHeartbeat?: boolean;
}

interface RemoteWorkerState {
  readonly generationController: AbortController;
  readonly events: WorkerEvent[];
  readonly listeners: Array<(ev: WorkerEvent) => void>;
  alive: boolean;
  terminatedIntentionally: boolean;
  terminalDelivered: boolean;
  pruneTimer: ReturnType<typeof setTimeout> | undefined;
  lastHeartbeat: WorkerEvent | undefined;
  cursor: unknown;
  watching: boolean;
}

interface RemoteStatusResponse {
  readonly alive: boolean;
}

const DEFAULT_METHOD_PREFIX = "workers";
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_PRUNE_GRACE_MS = 30_000;
const PROCESS_STATES: ReadonlySet<ProcessState> = new Set([
  "created",
  "running",
  "waiting",
  "suspended",
  "idle",
  "terminated",
]);

export function createRemoteBackend(options: CreateRemoteBackendOptions): WorkerBackend {
  const methodPrefix = options.methodPrefix ?? DEFAULT_METHOD_PREFIX;
  const now = options.now ?? Date.now;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const pruneGraceMs = Math.max(1, options.pruneGraceMs ?? DEFAULT_PRUNE_GRACE_MS);
  const sleep = options.sleep ?? sleepWithAbort;
  const { transport } = options;
  const workers = new Map<WorkerId, RemoteWorkerState>();

  const method = (name: string): string => `${methodPrefix}.${name}`;

  const emit = (id: WorkerId, state: RemoteWorkerState, ev: WorkerEvent): void => {
    if (ev.kind === "heartbeat") {
      state.lastHeartbeat = ev;
    } else {
      state.events.push(ev);
      if (ev.kind === "exited" || ev.kind === "crashed") {
        state.alive = false;
        if (state.pruneTimer === undefined) {
          state.pruneTimer = setTimeout(() => {
            if (!state.terminalDelivered && workers.get(id) === state) {
              workers.delete(id);
            }
          }, pruneGraceMs);
        }
      }
    }
    const pending = [...state.listeners];
    state.listeners.length = 0;
    for (const listener of pending) listener(ev);
  };

  const supportsHeartbeat = options.supportsHeartbeat === true;
  const backend: WorkerBackend = {
    kind: "remote",
    displayName: "remote",
    supportsHeartbeat,
    isAvailable: async (): Promise<boolean> => {
      try {
        const result = await transport.call<unknown>(method("probe"), {});
        if (!result.ok) return false;
        return parseProbeResponse(result.value).available;
      } catch {
        return false;
      }
    },
    spawn: async (request: WorkerSpawnRequest): Promise<Result<WorkerHandle, KoiError>> => {
      if (request.command.length === 0) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "WorkerSpawnRequest.command must be non-empty",
            retryable: false,
          },
        };
      }

      const previous = workers.get(request.workerId);
      if (previous !== undefined && previous.alive) {
        const term = await transport.call<void>(method("terminate"), {
          workerId: request.workerId,
          reason: "respawn",
        });
        if (!term.ok && term.error.code !== "NOT_FOUND") {
          return term as Result<WorkerHandle, KoiError>;
        }
        previous.terminatedIntentionally = true;
        if (!term.ok) {
          markRemoteExited(request.workerId, previous, "terminated");
        } else {
          const status = await transport.call<unknown>(method("status"), {
            workerId: request.workerId,
          });
          if (!status.ok && status.error.code === "NOT_FOUND") {
            markRemoteExited(request.workerId, previous, "terminated");
          } else if (status.ok) {
            const parsedStatus = parseStatusResponse(status.value);
            if (parsedStatus.ok && !parsedStatus.value.alive) {
              markRemoteExited(request.workerId, previous, "terminated");
            } else {
              return {
                ok: false,
                error: {
                  code: "CONFLICT",
                  message: `previous remote worker ${request.workerId} did not exit before respawn`,
                  retryable: true,
                },
              };
            }
          } else {
            return {
              ok: false,
              error: {
                code: "CONFLICT",
                message: `unable to confirm previous remote worker ${request.workerId} exited before respawn`,
                retryable: true,
              },
            };
          }
        }
      }

      const result = await transport.call<unknown>(method("spawn"), {
        workerId: request.workerId,
        agentId: request.agentId,
        command: [...request.command],
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
        ...(request.backendHints !== undefined ? { backendHints: request.backendHints } : {}),
      });
      if (!result.ok) return result as Result<WorkerHandle, KoiError>;

      const parsed = parseSpawnResponse(result.value, now(), request.workerId);
      if (!parsed.ok) return parsed;

      if (previous !== undefined) {
        previous.generationController.abort();
        if (previous.pruneTimer !== undefined) clearTimeout(previous.pruneTimer);
        workers.delete(request.workerId);
      }

      const state: RemoteWorkerState = {
        generationController: new AbortController(),
        events: [],
        listeners: [],
        alive: parsed.value.alive,
        terminatedIntentionally: false,
        terminalDelivered: false,
        pruneTimer: undefined,
        lastHeartbeat: undefined,
        cursor: parsed.value.cursor,
        watching: false,
      };
      workers.set(request.workerId, state);

      let sawStarted = false;
      let sawTerminal = false;
      for (const ev of parsed.value.events) {
        if (ev.kind === "started") sawStarted = true;
        if (isTerminalEvent(ev)) sawTerminal = true;
        emit(request.workerId, state, ev);
      }
      if (!sawStarted) {
        emit(request.workerId, state, {
          kind: "started",
          workerId: request.workerId,
          at: parsed.value.startedAt,
          ...(parsed.value.pid !== undefined ? { pid: parsed.value.pid } : {}),
        });
      }
      if (!parsed.value.alive && !sawTerminal) {
        emit(request.workerId, state, {
          kind: "crashed",
          workerId: request.workerId,
          at: now(),
          error: {
            code: "INTERNAL",
            message: `remote worker ${request.workerId} reported alive=false at spawn without a terminal event`,
            retryable: false,
          },
        });
      }

      const handle: WorkerHandle = {
        workerId: request.workerId,
        agentId: request.agentId,
        backendKind: "remote",
        startedAt: parsed.value.startedAt,
        signal: state.generationController.signal,
      };
      return { ok: true, value: handle };
    },
    terminate: async (id, reason) => {
      const state = workers.get(id);
      const result = await transport.call<void>(method("terminate"), { workerId: id, reason });
      if (!result.ok && result.error.code === "NOT_FOUND") {
        if (state !== undefined) {
          state.terminatedIntentionally = true;
          markRemoteExited(id, state, "terminated");
        }
        return { ok: true, value: undefined };
      }
      if (result.ok && state !== undefined) state.terminatedIntentionally = true;
      return result;
    },
    kill: async (id) => {
      const state = workers.get(id);
      const result = await transport.call<void>(method("kill"), { workerId: id });
      if (!result.ok && result.error.code === "NOT_FOUND") {
        if (state !== undefined) {
          state.terminatedIntentionally = true;
          markRemoteExited(id, state, "terminated");
        }
        return { ok: true, value: undefined };
      }
      if (result.ok && state !== undefined) state.terminatedIntentionally = true;
      return result;
    },
    isAlive: async (id) => {
      const state = workers.get(id);
      if (state !== undefined && !state.terminatedIntentionally) return state.alive;
      const result = await transport.call<unknown>(method("status"), { workerId: id });
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") {
          if (state !== undefined) markRemoteExited(id, state, "terminated");
          return false;
        }
        return state !== undefined ? state.alive : true;
      }
      const parsed = parseStatusResponse(result.value);
      if (!parsed.ok) return state !== undefined ? state.alive : true;
      if (!parsed.value.alive && state !== undefined) markRemoteExited(id, state, "terminated");
      return parsed.value.alive;
    },
    watch: async function* (id, signal) {
      const state = workers.get(id);
      if (state === undefined) {
        const status = await transport.call<unknown>(method("status"), { workerId: id });
        if (!status.ok && status.error.code === "NOT_FOUND") return;
        if (!status.ok)
          throw new Error(`remote watch status failed for ${id}: ${status.error.message}`);
        const parsed = parseStatusResponse(status.value);
        if (!parsed.ok || !parsed.value.alive) return;
        return;
      }
      if (signal?.aborted || state.generationController.signal.aborted) return;
      if (state.watching) {
        throw new Error(`remote watch already active for ${id}`);
      }
      state.watching = true;

      let cancelResolve: (() => void) | undefined;
      const onCancel = (): void => {
        if (cancelResolve !== undefined) {
          const resolve = cancelResolve;
          cancelResolve = undefined;
          resolve();
        }
      };

      signal?.addEventListener("abort", onCancel, { once: true });
      state.generationController.signal.addEventListener("abort", onCancel, { once: true });

      try {
        let cursor = 0;
        while (cursor < state.events.length) {
          const ev = state.events[cursor++];
          if (ev === undefined) break;
          yield ev;
          if (isTerminalEvent(ev)) {
            settleTerminal(id, state);
            return;
          }
        }
        if (state.lastHeartbeat !== undefined) yield state.lastHeartbeat;
        while (cursor < state.events.length) {
          const ev = state.events[cursor++];
          if (ev === undefined) break;
          yield ev;
          if (isTerminalEvent(ev)) {
            settleTerminal(id, state);
            return;
          }
        }

        while (true) {
          if (signal?.aborted || state.generationController.signal.aborted) return;
          while (cursor < state.events.length) {
            const ev = state.events[cursor++];
            if (ev === undefined) break;
            yield ev;
            if (isTerminalEvent(ev)) {
              settleTerminal(id, state);
              return;
            }
          }
          if (!state.alive) return;

          const polled = await transport.call<unknown>(
            method("events"),
            { workerId: id, cursor: state.cursor },
            signal !== undefined ? { signal } : undefined,
          );
          if (!polled.ok) {
            if (polled.error.code === "NOT_FOUND") {
              if (workers.get(id) === state) workers.delete(id);
              return;
            }
            throw new Error(`remote watch events failed for ${id}: ${polled.error.message}`);
          }

          const parsed = parseEventsResponse(polled.value, id);
          if (!parsed.ok) throw new Error(parsed.error.message);
          state.cursor = parsed.value.nextCursor;
          for (const ev of parsed.value.events) {
            emit(id, state, ev);
            if (ev.kind === "heartbeat") yield ev;
          }
          if (parsed.value.events.length > 0) continue;
          if (parsed.value.alive === false) {
            const synthetic: WorkerEvent = state.terminatedIntentionally
              ? {
                  kind: "exited",
                  workerId: id,
                  at: now(),
                  code: 0,
                  state: "terminated",
                }
              : {
                  kind: "crashed",
                  workerId: id,
                  at: now(),
                  error: {
                    code: "INTERNAL",
                    message: `remote worker ${id} reported alive=false without a terminal event`,
                    retryable: false,
                  },
                };
            emit(id, state, synthetic);
            yield synthetic;
            settleTerminal(id, state);
            return;
          }

          let eventListener: ((ev: WorkerEvent) => void) | undefined;
          const outcome = await new Promise<
            { readonly kind: "event"; readonly event: WorkerEvent } | { readonly kind: "cancel" }
          >((resolve) => {
            eventListener = (event): void => resolve({ kind: "event", event });
            state.listeners.push(eventListener);
            cancelResolve = (): void => resolve({ kind: "cancel" });
            void sleep(pollIntervalMs, signal ?? state.generationController.signal).then(
              () => {
                if (cancelResolve !== undefined) {
                  const resolveCancel = cancelResolve;
                  cancelResolve = undefined;
                  resolveCancel();
                }
              },
              () => {
                if (cancelResolve !== undefined) {
                  const resolveCancel = cancelResolve;
                  cancelResolve = undefined;
                  resolveCancel();
                }
              },
            );
          });
          cancelResolve = undefined;
          if (eventListener !== undefined) {
            const idx = state.listeners.indexOf(eventListener);
            if (idx !== -1) state.listeners.splice(idx, 1);
          }
          if (outcome.kind === "cancel") continue;
          yield outcome.event;
          if (outcome.event.kind !== "heartbeat") cursor++;
          if (isTerminalEvent(outcome.event)) {
            settleTerminal(id, state);
            return;
          }
        }
      } finally {
        state.watching = false;
        signal?.removeEventListener("abort", onCancel);
        state.generationController.signal.removeEventListener("abort", onCancel);
        if (cancelResolve !== undefined) {
          const resolve = cancelResolve;
          cancelResolve = undefined;
          resolve();
        }
      }
    },
  };

  return backend;

  function settleTerminal(id: WorkerId, state: RemoteWorkerState): void {
    state.terminalDelivered = true;
    if (state.pruneTimer !== undefined) clearTimeout(state.pruneTimer);
    if (workers.get(id) === state) workers.delete(id);
  }

  function markRemoteExited(
    id: WorkerId,
    state: RemoteWorkerState,
    processState: ProcessState,
  ): void {
    if (!state.alive) return;
    const hasTerminal = state.events.some(isTerminalEvent);
    if (!hasTerminal) {
      emit(id, state, {
        kind: "exited",
        workerId: id,
        at: now(),
        code: 0,
        state: processState,
      });
    }
    state.alive = false;
  }
}

function parseProbeResponse(value: unknown): {
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

function parseSpawnResponse(
  value: unknown,
  fallbackStartedAt: number,
  expectedWorkerId: WorkerId,
): Result<
  {
    readonly startedAt: number;
    readonly pid: number | undefined;
    readonly cursor: unknown;
    readonly alive: boolean;
    readonly events: readonly WorkerEvent[];
  },
  KoiError
> {
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

function parseStatusResponse(value: unknown): Result<RemoteStatusResponse, KoiError> {
  if (value === null || typeof value !== "object") {
    return invalidRemoteResponse("workers.status returned a non-object payload");
  }
  const alive = (value as Record<string, unknown>).alive;
  if (typeof alive !== "boolean") {
    return invalidRemoteResponse("workers.status returned a payload without boolean alive");
  }
  return { ok: true, value: { alive } };
}

function parseEventsResponse(
  value: unknown,
  expectedWorkerId: WorkerId,
): Result<
  {
    readonly nextCursor: unknown;
    readonly alive: boolean | undefined;
    readonly events: readonly WorkerEvent[];
  },
  KoiError
> {
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

  if (kind === "started") {
    const pid =
      typeof record.pid === "number" && Number.isFinite(record.pid) ? record.pid : undefined;
    return {
      ok: true,
      value: {
        kind,
        workerId: worker as WorkerId,
        at,
        ...(pid !== undefined ? { pid } : {}),
      },
    };
  }
  if (kind === "heartbeat") {
    return { ok: true, value: { kind, workerId: worker as WorkerId, at } };
  }
  if (kind === "exited") {
    if (typeof record.code !== "number" || typeof record.state !== "string") {
      return invalidRemoteResponse("remote exited event is missing code/state");
    }
    if (!PROCESS_STATES.has(record.state as ProcessState)) {
      return invalidRemoteResponse(`remote exited event has unsupported state "${record.state}"`);
    }
    return {
      ok: true,
      value: {
        kind,
        workerId: worker as WorkerId,
        at,
        code: record.code,
        state: record.state as ProcessState,
      },
    };
  }
  if (kind === "crashed") {
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
        kind,
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
  return { ok: true, value: null };
}

function invalidRemoteResponse<T>(message: string): Result<T, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
    },
  };
}

function isTerminalEvent(event: WorkerEvent): boolean {
  return event.kind === "exited" || event.kind === "crashed";
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
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
