import type { WorkerEvent, WorkerId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import {
  isTerminalEvent,
  parseEventsResponse,
  parseStatusResponse,
} from "./remote-backend-parsers.js";
import type { RemoteWorkerState, WorkerMap } from "./remote-backend-state.js";

export interface WatchCtx {
  readonly transport: NexusTransport;
  readonly method: (name: string) => string;
  readonly now: () => number;
  readonly pollIntervalMs: number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly workers: WorkerMap;
  readonly emit: (id: WorkerId, state: RemoteWorkerState, ev: WorkerEvent) => boolean;
  readonly settleTerminal: (id: WorkerId, state: RemoteWorkerState) => void;
}

export async function* watchImpl(
  ctx: WatchCtx,
  id: WorkerId,
  signal?: AbortSignal,
): AsyncGenerator<WorkerEvent, void, unknown> {
  const state = ctx.workers.get(id);
  if (state === undefined) {
    await checkUnknownWorker(ctx, id);
    return;
  }
  if (signal?.aborted || state.generationController.signal.aborted) return;
  if (state.watching) {
    throw new Error(`remote watch already active for ${id}`);
  }
  state.watching = true;
  yield* watchTracked(ctx, id, state, signal);
}

async function checkUnknownWorker(ctx: WatchCtx, id: WorkerId): Promise<void> {
  const status = await ctx.transport.call<unknown>(ctx.method("status"), { workerId: id });
  if (!status.ok && status.error.code === "NOT_FOUND") return;
  if (!status.ok) throw new Error(`remote watch status failed for ${id}: ${status.error.message}`);
  parseStatusResponse(status.value);
}

async function* watchTracked(
  ctx: WatchCtx,
  id: WorkerId,
  state: RemoteWorkerState,
  signal: AbortSignal | undefined,
): AsyncGenerator<WorkerEvent, void, unknown> {
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
    let drained = yield* drainBuffered(state, cursor);
    cursor = drained.cursor;
    if (drained.terminal) return ctx.settleTerminal(id, state);
    if (state.lastHeartbeat !== undefined) yield state.lastHeartbeat;
    drained = yield* drainBuffered(state, cursor);
    cursor = drained.cursor;
    if (drained.terminal) return ctx.settleTerminal(id, state);

    while (true) {
      if (signal?.aborted || state.generationController.signal.aborted) return;
      drained = yield* drainBuffered(state, cursor);
      cursor = drained.cursor;
      if (drained.terminal) return ctx.settleTerminal(id, state);
      if (!state.alive) return;

      const polled = await ctx.transport.call<unknown>(
        ctx.method("events"),
        { workerId: id, cursor: state.cursor },
        signal !== undefined ? { signal } : undefined,
      );
      if (!polled.ok) {
        if (polled.error.code === "NOT_FOUND") {
          if (ctx.workers.get(id) === state) ctx.workers.delete(id);
          return;
        }
        throw new Error(`remote watch events failed for ${id}: ${polled.error.message}`);
      }

      const parsed = parseEventsResponse(polled.value, id);
      if (!parsed.ok) throw new Error(parsed.error.message);
      state.cursor = parsed.value.nextCursor;
      for (const ev of parsed.value.events) {
        ctx.emit(id, state, ev);
        if (ev.kind === "heartbeat") yield ev;
      }
      if (parsed.value.events.length > 0) continue;
      if (parsed.value.alive === false) {
        const synthetic = synthesizeTerminal(ctx.now(), id, state);
        ctx.emit(id, state, synthetic);
        yield synthetic;
        ctx.settleTerminal(id, state);
        return;
      }

      const outcome = await waitForEvent(ctx, state, signal, (resolve) => {
        cancelResolve = resolve;
      });
      cancelResolve = undefined;
      if (outcome.kind === "cancel") continue;
      yield outcome.event;
      if (outcome.event.kind !== "heartbeat") cursor++;
      if (isTerminalEvent(outcome.event)) {
        ctx.settleTerminal(id, state);
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
}

function* drainBuffered(
  state: RemoteWorkerState,
  startCursor: number,
): Generator<WorkerEvent, { cursor: number; terminal: boolean }, unknown> {
  let cursor = startCursor;
  while (cursor < state.events.length) {
    const ev = state.events[cursor++];
    if (ev === undefined) break;
    yield ev;
    if (isTerminalEvent(ev)) return { cursor, terminal: true };
  }
  return { cursor, terminal: false };
}

function synthesizeTerminal(at: number, id: WorkerId, state: RemoteWorkerState): WorkerEvent {
  if (state.terminatedIntentionally) {
    return { kind: "exited", workerId: id, at, code: 0, state: "terminated" };
  }
  return {
    kind: "crashed",
    workerId: id,
    at,
    error: {
      code: "INTERNAL",
      message: `remote worker ${id} reported alive=false without a terminal event`,
      retryable: false,
    },
  };
}

type WaitOutcome =
  | { readonly kind: "event"; readonly event: WorkerEvent }
  | { readonly kind: "cancel" };

async function waitForEvent(
  ctx: WatchCtx,
  state: RemoteWorkerState,
  signal: AbortSignal | undefined,
  attachCancel: (resolve: () => void) => void,
): Promise<WaitOutcome> {
  let eventListener: ((ev: WorkerEvent) => void) | undefined;
  const outcome = await new Promise<WaitOutcome>((resolve) => {
    eventListener = (event): void => resolve({ kind: "event", event });
    state.listeners.push(eventListener);
    const cancel = (): void => resolve({ kind: "cancel" });
    attachCancel(cancel);
    void ctx
      .sleep(ctx.pollIntervalMs, signal ?? state.generationController.signal)
      .then(cancel, cancel);
  });
  if (eventListener !== undefined) {
    const idx = state.listeners.indexOf(eventListener);
    if (idx !== -1) state.listeners.splice(idx, 1);
  }
  return outcome;
}
