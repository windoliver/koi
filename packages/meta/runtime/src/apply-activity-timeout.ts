/**
 * Activity-based timeout wrapper for EngineAdapter streams (#1638).
 *
 * Replaces hard wall-clock kills with inactivity heartbeats:
 * - Any EngineEvent yielded by the adapter counts as activity (resets the idle clock)
 * - When idle exceeds `idleWarnMs`, a `custom: activity.idle.warning` event is injected
 * - When idle exceeds `idleTerminateMs` (default 2 × idleWarnMs), the stream aborts
 *   with `custom: activity.terminated.idle`
 * - A separate `maxDurationMs` acts as a final wall-clock safety bound, firing
 *   `custom: activity.terminated.wall_clock`
 *
 * Observers can hook `onIdleWarn` / `onTerminated` for telemetry or cooperative
 * cancellation (e.g. inject a system-reminder on the next turn).
 */

import type { EngineAdapter, EngineEvent, EngineInput } from "@koi/core";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface IdleWarningInfo {
  readonly elapsedMs: number;
  readonly warnMs: number;
  readonly terminateMs: number;
}

export type ActivityTerminationReason = "idle" | "wall_clock";

export interface ActivityTimeoutConfig {
  /** Emit warning when no activity for this many ms. Omit to disable inactivity warning. */
  readonly idleWarnMs?: number;
  /** Abort the stream when idle exceeds this. Default: 2 × idleWarnMs. Only applies if idleWarnMs is set. */
  readonly idleTerminateMs?: number;
  /** Absolute wall-clock cap regardless of activity. Omit to disable. */
  readonly maxDurationMs?: number;
  /** Observer invoked when the idle warning fires. */
  readonly onIdleWarn?: (info: IdleWarningInfo) => void;
  /** Observer invoked when the stream is terminated by the wrapper. */
  readonly onTerminated?: (reason: ActivityTerminationReason, elapsedMs: number) => void;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Telemetry event types
// ---------------------------------------------------------------------------

export const ACTIVITY_IDLE_WARNING = "activity.idle.warning";
export const ACTIVITY_TERMINATED_IDLE = "activity.terminated.idle";
export const ACTIVITY_TERMINATED_WALL_CLOCK = "activity.terminated.wall_clock";

// ---------------------------------------------------------------------------
// Wrapper factory
// ---------------------------------------------------------------------------

export function applyActivityTimeout(
  adapter: EngineAdapter,
  config: ActivityTimeoutConfig,
): EngineAdapter {
  if (!hasAnyTimeout(config)) {
    return adapter;
  }
  return {
    ...adapter,
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      return wrapStream(adapter, input, config);
    },
  };
}

function hasAnyTimeout(config: ActivityTimeoutConfig): boolean {
  return config.idleWarnMs !== undefined || config.maxDurationMs !== undefined;
}

function resolveTerminateMs(config: ActivityTimeoutConfig): number | undefined {
  if (config.idleWarnMs === undefined) return undefined;
  return config.idleTerminateMs ?? config.idleWarnMs * 2;
}

// ---------------------------------------------------------------------------
// Stream wrapper — interleaves adapter events with timeout telemetry
// ---------------------------------------------------------------------------

async function* wrapStream(
  adapter: EngineAdapter,
  input: EngineInput,
  config: ActivityTimeoutConfig,
): AsyncGenerator<EngineEvent, void, void> {
  const now = config.now ?? Date.now;
  const warnMs = config.idleWarnMs;
  const terminateMs = resolveTerminateMs(config);
  const maxMs = config.maxDurationMs;

  const startedAt = now();
  const state: WrapperState = {
    lastActivity: startedAt,
    terminated: null,
    pumpDone: false,
    pumpError: undefined,
    queue: [],
    waker: null,
  };

  const ctl = new AbortController();
  const signal = composeSignal(input.signal, ctl.signal);

  const timers = armTimers({ state, config, now, warnMs, terminateMs, maxMs, startedAt, ctl });
  const pump = pumpInner(adapter, { ...input, signal }, state, now);

  try {
    while (true) {
      while (state.queue.length > 0) {
        const ev = state.queue.shift();
        if (ev === undefined) break;
        yield ev;
        if (ev.kind === "done") return;
        if (state.terminated !== null) return;
      }
      if (state.pumpDone) {
        if (state.pumpError !== undefined) throw state.pumpError;
        return;
      }
      await new Promise<void>((resolve) => {
        state.waker = resolve;
      });
    }
  } finally {
    clearAll(timers);
    ctl.abort();
    await pump.catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface WrapperState {
  // let: all fields mutated by timer callbacks and pump loop
  lastActivity: number;
  terminated: { readonly reason: ActivityTerminationReason; readonly elapsedMs: number } | null;
  pumpDone: boolean;
  pumpError: unknown;
  readonly queue: EngineEvent[];
  waker: (() => void) | null;
}

interface Timers {
  // let: re-armed across callbacks
  warnTimer: ReturnType<typeof setTimeout> | null;
  termTimer: ReturnType<typeof setTimeout> | null;
  wallTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Timer wiring
// ---------------------------------------------------------------------------

interface ArmTimersDeps {
  readonly state: WrapperState;
  readonly config: ActivityTimeoutConfig;
  readonly now: () => number;
  readonly warnMs: number | undefined;
  readonly terminateMs: number | undefined;
  readonly maxMs: number | undefined;
  readonly startedAt: number;
  readonly ctl: AbortController;
}

function armTimers(deps: ArmTimersDeps): Timers {
  const timers: Timers = { warnTimer: null, termTimer: null, wallTimer: null };

  if (deps.warnMs !== undefined) {
    scheduleWarn(timers, deps);
  }
  if (deps.maxMs !== undefined) {
    scheduleWall(timers, deps);
  }
  return timers;
}

function scheduleWarn(timers: Timers, deps: ArmTimersDeps): void {
  const warnMs = deps.warnMs;
  if (warnMs === undefined) return;
  const elapsed = deps.now() - deps.state.lastActivity;
  const delay = Math.max(warnMs - elapsed, 0);
  timers.warnTimer = setTimeout(() => checkWarn(timers, deps), delay);
}

function checkWarn(timers: Timers, deps: ArmTimersDeps): void {
  const { state, now } = deps;
  const warnMs = deps.warnMs;
  if (warnMs === undefined) return;
  if (state.terminated !== null) return;

  const elapsed = now() - state.lastActivity;
  if (elapsed < warnMs) {
    scheduleWarn(timers, deps);
    return;
  }
  // Fire warning (idempotent — only enqueue once per idle stretch)
  const termMs = deps.terminateMs ?? warnMs * 2;
  const info: IdleWarningInfo = { elapsedMs: elapsed, warnMs, terminateMs: termMs };
  enqueue(state, { kind: "custom", type: ACTIVITY_IDLE_WARNING, data: info });
  deps.config.onIdleWarn?.(info);

  if (timers.termTimer === null) {
    scheduleTerm(timers, deps);
  }
}

function scheduleTerm(timers: Timers, deps: ArmTimersDeps): void {
  const termMs = deps.terminateMs;
  if (termMs === undefined) return;
  const elapsed = deps.now() - deps.state.lastActivity;
  const delay = Math.max(termMs - elapsed, 0);
  timers.termTimer = setTimeout(() => checkTerm(timers, deps), delay);
}

function checkTerm(timers: Timers, deps: ArmTimersDeps): void {
  const { state, now, ctl } = deps;
  const termMs = deps.terminateMs;
  if (termMs === undefined) return;
  if (state.terminated !== null) return;

  const elapsed = now() - state.lastActivity;
  if (elapsed < termMs) {
    // Activity reset since warning — re-arm and leave warning-fired state untouched.
    // If activity continues, the warn timer will catch any new idle stretch.
    timers.termTimer = null;
    return;
  }
  state.terminated = { reason: "idle", elapsedMs: elapsed };
  enqueue(state, { kind: "custom", type: ACTIVITY_TERMINATED_IDLE, data: { elapsedMs: elapsed } });
  deps.config.onTerminated?.("idle", elapsed);
  ctl.abort();
}

function scheduleWall(timers: Timers, deps: ArmTimersDeps): void {
  const maxMs = deps.maxMs;
  if (maxMs === undefined) return;
  timers.wallTimer = setTimeout(() => {
    const { state, now, ctl } = deps;
    if (state.terminated !== null) return;
    const elapsed = now() - deps.startedAt;
    state.terminated = { reason: "wall_clock", elapsedMs: elapsed };
    enqueue(state, {
      kind: "custom",
      type: ACTIVITY_TERMINATED_WALL_CLOCK,
      data: { elapsedMs: elapsed },
    });
    deps.config.onTerminated?.("wall_clock", elapsed);
    ctl.abort();
  }, maxMs);
}

function clearAll(timers: Timers): void {
  if (timers.warnTimer !== null) clearTimeout(timers.warnTimer);
  if (timers.termTimer !== null) clearTimeout(timers.termTimer);
  if (timers.wallTimer !== null) clearTimeout(timers.wallTimer);
}

// ---------------------------------------------------------------------------
// Pump — drain the inner stream into a queue, recording activity
// ---------------------------------------------------------------------------

async function pumpInner(
  adapter: EngineAdapter,
  input: EngineInput,
  state: WrapperState,
  now: () => number,
): Promise<void> {
  try {
    for await (const ev of adapter.stream(input)) {
      if (state.terminated !== null) break;
      state.lastActivity = now();
      enqueue(state, ev);
      if (ev.kind === "done") break;
    }
  } catch (err) {
    // Swallow abort errors caused by our own termination; surface everything else.
    if (state.terminated === null && !isAbortError(err)) {
      state.pumpError = err;
    }
  } finally {
    state.pumpDone = true;
    wake(state);
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === "AbortError";
  if (err instanceof Error) return err.name === "AbortError";
  return false;
}

function enqueue(state: WrapperState, ev: EngineEvent): void {
  state.queue.push(ev);
  wake(state);
}

function wake(state: WrapperState): void {
  const resolve = state.waker;
  if (resolve !== null) {
    state.waker = null;
    resolve();
  }
}

// ---------------------------------------------------------------------------
// Signal composition
// ---------------------------------------------------------------------------

function composeSignal(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  if (external === undefined) return internal;
  return AbortSignal.any([external, internal]);
}
