import type { ProcessState, WorkerEvent, WorkerId } from "@koi/core";
import { isTerminalEvent } from "./remote-backend-parsers.js";

export interface RemoteWorkerState {
  readonly generationController: AbortController;
  readonly events: WorkerEvent[];
  readonly listeners: Array<(ev: WorkerEvent) => void>;
  readonly delivered: Set<string>;
  alive: boolean;
  terminatedIntentionally: boolean;
  terminalDelivered: boolean;
  pruneTimer: ReturnType<typeof setTimeout> | undefined;
  lastHeartbeat: WorkerEvent | undefined;
  cursor: unknown;
  watching: boolean;
}

export type WorkerMap = Map<WorkerId, RemoteWorkerState>;

export function createRemoteState(initial: { alive: boolean; cursor: unknown }): RemoteWorkerState {
  return {
    generationController: new AbortController(),
    events: [],
    listeners: [],
    delivered: new Set<string>(),
    alive: initial.alive,
    terminatedIntentionally: false,
    terminalDelivered: false,
    pruneTimer: undefined,
    lastHeartbeat: undefined,
    cursor: initial.cursor,
    watching: false,
  };
}

export function fingerprint(ev: WorkerEvent): string {
  if (ev.kind === "exited") return `exited:${ev.at}:${ev.code}:${ev.state}`;
  if (ev.kind === "crashed") return `crashed:${ev.at}:${ev.error.code}`;
  if (ev.kind === "started") return `started:${ev.at}:${ev.pid ?? ""}`;
  return `heartbeat:${ev.at}`;
}

export function emitEvent(
  workers: WorkerMap,
  pruneGraceMs: number,
  id: WorkerId,
  state: RemoteWorkerState,
  ev: WorkerEvent,
): boolean {
  if (ev.kind !== "heartbeat") {
    const fp = fingerprint(ev);
    if (state.delivered.has(fp)) return false;
    state.delivered.add(fp);
  }
  if (ev.kind === "heartbeat") {
    state.lastHeartbeat = ev;
  } else {
    state.events.push(ev);
    if (isTerminalEvent(ev)) {
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
  return true;
}

export function settleTerminal(workers: WorkerMap, id: WorkerId, state: RemoteWorkerState): void {
  state.terminalDelivered = true;
  if (state.pruneTimer !== undefined) clearTimeout(state.pruneTimer);
  if (workers.get(id) === state) workers.delete(id);
}

export function markRemoteExited(
  emit: (id: WorkerId, state: RemoteWorkerState, ev: WorkerEvent) => boolean,
  now: () => number,
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
