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
import {
  isTerminalEvent,
  parseProbeResponse,
  parseSpawnResponse,
  parseStatusResponse,
  sleepWithAbort,
} from "./remote-backend-parsers.js";
import {
  createRemoteState,
  emitEvent,
  markRemoteExited as markRemoteExitedFn,
  type RemoteWorkerState,
  settleTerminal as settleTerminalFn,
  type WorkerMap,
} from "./remote-backend-state.js";
import { watchImpl } from "./remote-backend-watch.js";

interface CreateRemoteBackendOptions {
  readonly transport: NexusTransport;
  readonly methodPrefix?: string;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly pruneGraceMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly supportsHeartbeat?: boolean;
}

interface BackendCtx {
  readonly transport: NexusTransport;
  readonly method: (name: string) => string;
  readonly now: () => number;
  readonly pollIntervalMs: number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly workers: WorkerMap;
  readonly emit: (id: WorkerId, state: RemoteWorkerState, ev: WorkerEvent) => boolean;
  readonly settleTerminal: (id: WorkerId, state: RemoteWorkerState) => void;
  readonly markRemoteExited: (
    id: WorkerId,
    state: RemoteWorkerState,
    processState: ProcessState,
  ) => void;
}

const DEFAULT_METHOD_PREFIX = "workers";
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_PRUNE_GRACE_MS = 30_000;

export function createRemoteBackend(options: CreateRemoteBackendOptions): WorkerBackend {
  const ctx = createCtx(options);
  const supportsHeartbeat = options.supportsHeartbeat === true;

  return {
    kind: "remote",
    displayName: "remote",
    supportsHeartbeat,
    isAvailable: () => isAvailableImpl(ctx),
    spawn: (request) => spawnImpl(ctx, request),
    terminate: (id, reason) => terminateImpl(ctx, id, reason),
    kill: (id) => killImpl(ctx, id),
    isAlive: (id) => isAliveImpl(ctx, id),
    watch: (id, signal) => watchImpl(ctx, id, signal),
  };
}

function createCtx(options: CreateRemoteBackendOptions): BackendCtx {
  const methodPrefix = options.methodPrefix ?? DEFAULT_METHOD_PREFIX;
  const pruneGraceMs = Math.max(1, options.pruneGraceMs ?? DEFAULT_PRUNE_GRACE_MS);
  const workers: WorkerMap = new Map();
  const now = options.now ?? Date.now;
  const emit = (id: WorkerId, state: RemoteWorkerState, ev: WorkerEvent): boolean =>
    emitEvent(workers, pruneGraceMs, id, state, ev);
  return {
    transport: options.transport,
    method: (name: string): string => `${methodPrefix}.${name}`,
    now,
    pollIntervalMs: Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    sleep: options.sleep ?? sleepWithAbort,
    workers,
    emit,
    settleTerminal: (id, state) => settleTerminalFn(workers, id, state),
    markRemoteExited: (id, state, ps) => markRemoteExitedFn(emit, now, id, state, ps),
  };
}

async function isAvailableImpl(ctx: BackendCtx): Promise<boolean> {
  try {
    const result = await ctx.transport.call<unknown>(ctx.method("probe"), {});
    if (!result.ok) return false;
    return parseProbeResponse(result.value).available;
  } catch {
    return false;
  }
}

async function spawnImpl(
  ctx: BackendCtx,
  request: WorkerSpawnRequest,
): Promise<Result<WorkerHandle, KoiError>> {
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

  const previous = ctx.workers.get(request.workerId);
  if (previous !== undefined && previous.alive) {
    const prepared = await prepareRespawn(ctx, request.workerId, previous);
    if (!prepared.ok) return prepared;
  }

  const result = await ctx.transport.call<unknown>(ctx.method("spawn"), {
    workerId: request.workerId,
    agentId: request.agentId,
    command: [...request.command],
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
    ...(request.env !== undefined ? { env: request.env } : {}),
    ...(request.backendHints !== undefined ? { backendHints: request.backendHints } : {}),
  });
  if (!result.ok) return result as Result<WorkerHandle, KoiError>;

  const parsed = parseSpawnResponse(result.value, ctx.now(), request.workerId);
  if (!parsed.ok) return parsed;

  if (previous !== undefined) {
    previous.generationController.abort();
    if (previous.pruneTimer !== undefined) clearTimeout(previous.pruneTimer);
    ctx.workers.delete(request.workerId);
  }

  const state = createRemoteState({
    alive: parsed.value.alive,
    cursor: parsed.value.cursor,
  });
  ctx.workers.set(request.workerId, state);
  emitInitialEvents(ctx, request, state, parsed.value);

  return {
    ok: true,
    value: {
      workerId: request.workerId,
      agentId: request.agentId,
      backendKind: "remote",
      startedAt: parsed.value.startedAt,
      signal: state.generationController.signal,
    },
  };
}

function emitInitialEvents(
  ctx: BackendCtx,
  request: WorkerSpawnRequest,
  state: RemoteWorkerState,
  parsed: {
    readonly startedAt: number;
    readonly pid: number | undefined;
    readonly alive: boolean;
    readonly events: readonly WorkerEvent[];
  },
): void {
  let sawStarted = false;
  let sawTerminal = false;
  for (const ev of parsed.events) {
    if (ev.kind === "started") sawStarted = true;
    if (isTerminalEvent(ev)) sawTerminal = true;
    ctx.emit(request.workerId, state, ev);
  }
  if (!sawStarted) {
    ctx.emit(request.workerId, state, {
      kind: "started",
      workerId: request.workerId,
      at: parsed.startedAt,
      ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}),
    });
  }
  if (!parsed.alive && !sawTerminal) {
    ctx.emit(request.workerId, state, {
      kind: "crashed",
      workerId: request.workerId,
      at: ctx.now(),
      error: {
        code: "INTERNAL",
        message: `remote worker ${request.workerId} reported alive=false at spawn without a terminal event`,
        retryable: false,
      },
    });
  }
}

async function prepareRespawn(
  ctx: BackendCtx,
  workerId: WorkerId,
  previous: RemoteWorkerState,
): Promise<Result<undefined, KoiError>> {
  const term = await ctx.transport.call<void>(ctx.method("terminate"), {
    workerId,
    reason: "respawn",
  });
  if (!term.ok && term.error.code !== "NOT_FOUND") {
    return term as Result<undefined, KoiError>;
  }
  previous.terminatedIntentionally = true;
  if (!term.ok) {
    ctx.markRemoteExited(workerId, previous, "terminated");
    return { ok: true, value: undefined };
  }
  const status = await ctx.transport.call<unknown>(ctx.method("status"), { workerId });
  if (!status.ok && status.error.code === "NOT_FOUND") {
    ctx.markRemoteExited(workerId, previous, "terminated");
    return { ok: true, value: undefined };
  }
  if (!status.ok) {
    return conflict(workerId, "unable to confirm previous remote worker exited before respawn");
  }
  const parsedStatus = parseStatusResponse(status.value);
  if (parsedStatus.ok && !parsedStatus.value.alive) {
    ctx.markRemoteExited(workerId, previous, "terminated");
    return { ok: true, value: undefined };
  }
  return conflict(workerId, "previous remote worker did not exit before respawn");
}

function conflict(workerId: WorkerId, message: string): Result<undefined, KoiError> {
  return {
    ok: false,
    error: { code: "CONFLICT", message: `${message}: ${workerId}`, retryable: true },
  };
}

async function terminateImpl(
  ctx: BackendCtx,
  id: WorkerId,
  reason: string | undefined,
): Promise<Result<void, KoiError>> {
  const state = ctx.workers.get(id);
  const result = await ctx.transport.call<void>(ctx.method("terminate"), { workerId: id, reason });
  if (!result.ok && result.error.code === "NOT_FOUND") {
    if (state !== undefined) {
      state.terminatedIntentionally = true;
      ctx.markRemoteExited(id, state, "terminated");
    }
    return { ok: true, value: undefined };
  }
  if (result.ok && state !== undefined) state.terminatedIntentionally = true;
  return result;
}

async function killImpl(ctx: BackendCtx, id: WorkerId): Promise<Result<void, KoiError>> {
  const state = ctx.workers.get(id);
  const result = await ctx.transport.call<void>(ctx.method("kill"), { workerId: id });
  if (!result.ok && result.error.code === "NOT_FOUND") {
    if (state !== undefined) {
      state.terminatedIntentionally = true;
      ctx.markRemoteExited(id, state, "terminated");
    }
    return { ok: true, value: undefined };
  }
  if (result.ok && state !== undefined) state.terminatedIntentionally = true;
  return result;
}

async function isAliveImpl(ctx: BackendCtx, id: WorkerId): Promise<boolean> {
  const state = ctx.workers.get(id);
  if (state !== undefined && !state.terminatedIntentionally) return state.alive;
  const result = await ctx.transport.call<unknown>(ctx.method("status"), { workerId: id });
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") {
      if (state !== undefined) ctx.markRemoteExited(id, state, "terminated");
      return false;
    }
    return state !== undefined ? state.alive : true;
  }
  const parsed = parseStatusResponse(result.value);
  if (!parsed.ok) return state !== undefined ? state.alive : true;
  if (!parsed.value.alive && state !== undefined) ctx.markRemoteExited(id, state, "terminated");
  return parsed.value.alive;
}
