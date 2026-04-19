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
 * Tool execution is treated as activity: between `tool_call_start` and
 * `tool_call_end` the idle clock is suspended so legitimately long tools
 * (builds, test runs, HTTP calls) do not trigger an idle timeout despite
 * producing no intermediate adapter events.
 *
 * Observers (`onIdleWarn` / `onTerminated`) are invoked defensively — a host
 * callback that throws is logged and swallowed so telemetry misbehaviour cannot
 * crash the runtime or strand cleanup.
 */

import type { EngineAdapter, EngineEvent, EngineInput, ToolCallId } from "@koi/core";

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
  /** Observer invoked when the idle warning fires. Exceptions are swallowed. */
  readonly onIdleWarn?: (info: IdleWarningInfo) => void;
  /** Observer invoked when the stream is terminated by the wrapper. Exceptions are swallowed. */
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
  return isPositiveFinite(config.idleWarnMs) || isPositiveFinite(config.maxDurationMs);
}

function resolveTerminateMs(config: ActivityTimeoutConfig): number | undefined {
  if (!isPositiveFinite(config.idleWarnMs)) return undefined;
  const explicit = config.idleTerminateMs;
  if (isPositiveFinite(explicit)) return explicit;
  return config.idleWarnMs * 2;
}

/**
 * `setTimeout(Infinity)` overflows to ~1ms in Node/Bun rather than disabling
 * the timer, so non-finite durations must be treated as "no timer" — this is
 * also the documented opt-out for callers who want no wall-clock cap:
 * `maxDurationMs: Number.POSITIVE_INFINITY`.
 */
function isPositiveFinite(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n > 0;
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
    warnFired: false,
    pendingTools: new Set<ToolCallId>(),
    terminated: null,
    pumpDone: false,
    pumpError: undefined,
    queue: [],
    waker: null,
  };

  const ctl = new AbortController();
  const signal = composeSignal(input.signal, ctl.signal);

  const deps: TimerDeps = { state, config, now, warnMs, terminateMs, maxMs, startedAt, ctl };
  const timers = armTimers(deps);
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
    // Deliberately DO NOT await the pump: a non-cooperative adapter that
    // ignores its abort signal would otherwise hang generator finalization
    // forever. The pump promise already has a rejection handler attached
    // (via the assignment sink in pumpInner's catch/finally), and its queue
    // writes after this point are harmless — the consumer is gone.
    pump.catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface WrapperState {
  // let: all fields mutated by timer callbacks and pump loop
  lastActivity: number;
  /** True while the current idle stretch has already emitted its warning. Reset on any activity. */
  warnFired: boolean;
  /** Tool call IDs that have started (tool_call_start) but not yet ended (tool_call_end). */
  readonly pendingTools: Set<ToolCallId>;
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

interface TimerDeps {
  readonly state: WrapperState;
  readonly config: ActivityTimeoutConfig;
  readonly now: () => number;
  readonly warnMs: number | undefined;
  readonly terminateMs: number | undefined;
  readonly maxMs: number | undefined;
  readonly startedAt: number;
  readonly ctl: AbortController;
}

function armTimers(deps: TimerDeps): Timers {
  const timers: Timers = { warnTimer: null, termTimer: null, wallTimer: null };
  if (isPositiveFinite(deps.warnMs)) scheduleWarn(timers, deps);
  if (isPositiveFinite(deps.maxMs)) scheduleWall(timers, deps);
  return timers;
}

/**
 * Idle time effectively elapsed. Tool calls in flight freeze the idle clock
 * — a long-running tool is NOT classified as inactivity.
 */
function idleElapsed(state: WrapperState, now: () => number): number {
  if (state.pendingTools.size > 0) return 0;
  return now() - state.lastActivity;
}

function scheduleWarn(timers: Timers, deps: TimerDeps): void {
  if (!isPositiveFinite(deps.warnMs)) return;
  const remaining = deps.warnMs - idleElapsed(deps.state, deps.now);
  const delay = Math.max(remaining, 0);
  timers.warnTimer = setTimeout(() => checkWarn(timers, deps), delay);
}

function checkWarn(timers: Timers, deps: TimerDeps): void {
  timers.warnTimer = null;
  if (deps.warnMs === undefined) return;
  if (deps.state.terminated !== null) return;

  const elapsed = idleElapsed(deps.state, deps.now);
  if (elapsed < deps.warnMs) {
    scheduleWarn(timers, deps);
    return;
  }

  if (!deps.state.warnFired) {
    deps.state.warnFired = true;
    const termMs = deps.terminateMs ?? deps.warnMs * 2;
    const info: IdleWarningInfo = { elapsedMs: elapsed, warnMs: deps.warnMs, terminateMs: termMs };
    enqueue(deps.state, { kind: "custom", type: ACTIVITY_IDLE_WARNING, data: info });
    safeObserver("onIdleWarn", () => deps.config.onIdleWarn?.(info));
    if (timers.termTimer === null) scheduleTerm(timers, deps);
  }

  // Re-arm so subsequent idle stretches (after recovery) get a fresh warning cycle.
  scheduleWarn(timers, deps);
}

function scheduleTerm(timers: Timers, deps: TimerDeps): void {
  if (!isPositiveFinite(deps.terminateMs)) return;
  const remaining = deps.terminateMs - idleElapsed(deps.state, deps.now);
  const delay = Math.max(remaining, 0);
  timers.termTimer = setTimeout(() => checkTerm(timers, deps), delay);
}

function checkTerm(timers: Timers, deps: TimerDeps): void {
  timers.termTimer = null;
  if (deps.terminateMs === undefined) return;
  if (deps.state.terminated !== null) return;

  const elapsed = idleElapsed(deps.state, deps.now);
  if (elapsed < deps.terminateMs) {
    // Activity (or a tool call) reset the idle clock — leave term disarmed;
    // the warn timer will re-arm termination if a future idle stretch fires.
    return;
  }
  deps.state.terminated = { reason: "idle", elapsedMs: elapsed };
  enqueue(deps.state, {
    kind: "custom",
    type: ACTIVITY_TERMINATED_IDLE,
    data: { elapsedMs: elapsed },
  });
  safeObserver("onTerminated:idle", () => deps.config.onTerminated?.("idle", elapsed));
  deps.ctl.abort();
}

function scheduleWall(timers: Timers, deps: TimerDeps): void {
  if (!isPositiveFinite(deps.maxMs)) return;
  timers.wallTimer = setTimeout(() => {
    timers.wallTimer = null;
    if (deps.state.terminated !== null) return;
    const elapsed = deps.now() - deps.startedAt;
    deps.state.terminated = { reason: "wall_clock", elapsedMs: elapsed };
    enqueue(deps.state, {
      kind: "custom",
      type: ACTIVITY_TERMINATED_WALL_CLOCK,
      data: { elapsedMs: elapsed },
    });
    safeObserver("onTerminated:wall_clock", () =>
      deps.config.onTerminated?.("wall_clock", elapsed),
    );
    deps.ctl.abort();
  }, deps.maxMs);
}

function clearAll(timers: Timers): void {
  if (timers.warnTimer !== null) clearTimeout(timers.warnTimer);
  if (timers.termTimer !== null) clearTimeout(timers.termTimer);
  if (timers.wallTimer !== null) clearTimeout(timers.wallTimer);
}

/**
 * Invoke a host observer callback. Exceptions are caught and logged so a
 * misbehaving callback cannot escape a `setTimeout` frame and crash the
 * process or skip the wrapper's own cleanup / abort propagation.
 */
function safeObserver(label: string, run: () => void): void {
  try {
    run();
  } catch (err: unknown) {
    console.error(`[apply-activity-timeout] ${label} observer threw:`, err);
  }
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
      recordActivity(state, ev, now);
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

function recordActivity(state: WrapperState, ev: EngineEvent, now: () => number): void {
  state.lastActivity = now();
  state.warnFired = false;
  // Tool lifecycle (engine.ts contract):
  //   tool_call_start → tool_call_delta → tool_call_end  (model streams the call)
  //   [tool executes — can be many minutes of silence]
  //   tool_result                                         (turn-runner emits after execution)
  //
  // Only the post-tool_call_end execution gap is truly silent "useful work".
  // Argument streaming (between tool_call_start and tool_call_end) produces
  // events on every delta; a stall there is a real stuck stream and must NOT
  // be masked by pendingTools. So the idle-free window is tool_call_end..tool_result.
  if (ev.kind === "tool_call_end") {
    state.pendingTools.add(ev.callId);
  } else if (ev.kind === "tool_result") {
    state.pendingTools.delete(ev.callId);
  } else if (ev.kind === "turn_end") {
    // Belt-and-suspenders: a turn cannot end with in-flight tool calls. Drop
    // any stragglers so an error path that swallowed tool_result cannot strand
    // idle accounting forever.
    state.pendingTools.clear();
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
