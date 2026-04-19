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

import type {
  AbortReason,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  ToolCallId,
} from "@koi/core";

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
  validateActivityTimeoutConfig(config);
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

/**
 * Reject invalid durations up front so a misconfigured value cannot silently
 * remove the timeout guard. Negative values throw; `0` is accepted as
 * "fire on next tick" (preserves legacy `streamTimeoutMs: 0` behaviour
 * where `AbortSignal.timeout(0)` aborted immediately); `Infinity` is the
 * documented opt-out for no wall-clock cap.
 */
function validateActivityTimeoutConfig(config: ActivityTimeoutConfig): void {
  const fields: readonly [string, number | undefined][] = [
    ["idleWarnMs", config.idleWarnMs],
    ["idleTerminateMs", config.idleTerminateMs],
    ["maxDurationMs", config.maxDurationMs],
  ];
  for (const [name, value] of fields) {
    if (value === undefined) continue;
    if (Number.isNaN(value)) {
      throw new Error(`activityTimeout.${name} must be a number, got NaN`);
    }
    if (Number.isFinite(value) && value < 0) {
      throw new Error(
        `activityTimeout.${name} must be >= 0 or Number.POSITIVE_INFINITY, got ${value}`,
      );
    }
  }
}

function hasAnyTimeout(config: ActivityTimeoutConfig): boolean {
  return isSchedulable(config.idleWarnMs) || isSchedulable(config.maxDurationMs);
}

function resolveTerminateMs(config: ActivityTimeoutConfig): number | undefined {
  if (!isSchedulable(config.idleWarnMs)) return undefined;
  const explicit = config.idleTerminateMs;
  if (isSchedulable(explicit)) return explicit;
  return config.idleWarnMs * 2;
}

/**
 * A duration is schedulable iff it is a finite, non-negative number.
 *
 * - `setTimeout(Infinity)` overflows to ~1ms in Node/Bun rather than disabling
 *   the timer, so non-finite durations must be treated as "no timer" — this is
 *   the documented opt-out for callers who want no wall-clock cap:
 *   `maxDurationMs: Number.POSITIVE_INFINITY`.
 * - Zero is a valid schedulable delay (fires on the next tick) to preserve the
 *   legacy `streamTimeoutMs: 0` semantic — any negative input is rejected up
 *   front by `validateActivityTimeoutConfig`.
 */
function isSchedulable(n: number | undefined): n is number {
  // Accept 0 as a schedulable delay (fires on the next tick) — this preserves
  // the legacy `AbortSignal.timeout(0)` semantic where `streamTimeoutMs: 0`
  // aborted the stream immediately. Negative values are rejected at
  // validation time. `Infinity` is the documented opt-out — not schedulable.
  return n !== undefined && Number.isFinite(n) && n >= 0;
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
    currentTurnIndex: null,
    lastSeenTurnIndex: null,
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

  function onActivity(ev: EngineEvent): void {
    const wasWarnFired = state.warnFired;
    recordActivity(state, ev, now);
    // checkWarn intentionally does not re-arm itself after firing (see its
    // comment — otherwise setTimeout(0) would busy-loop while idle exceeds
    // warnMs). When activity resets `warnFired`, we must arm the next cycle
    // here so a subsequent idle stretch still gets a fresh warning +
    // termination window.
    if (wasWarnFired && timers.warnTimer === null && isSchedulable(deps.warnMs)) {
      scheduleWarn(timers, deps);
    }
  }

  const pump = pumpInner(adapter, { ...input, signal }, state, onActivity);

  try {
    while (true) {
      while (state.queue.length > 0) {
        const ev = state.queue.shift();
        if (ev === undefined) break;
        yield ev;
        if (ev.kind === "done") return;
      }
      if (state.pumpDone) {
        if (state.pumpError !== undefined) throw state.pumpError;
        return;
      }
      if (state.terminated !== null) {
        // Termination path has already enqueued its telemetry + synthesized
        // terminal `done` (see checkTerm / scheduleWall). If the queue is
        // drained and we reach here, no more events are coming — return
        // instead of blocking on the waker.
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
  /** Index of the currently-open turn (from turn_start); null between turns. */
  currentTurnIndex: number | null;
  /** Highest turn index observed so far (from turn_start); null if no turn has started. */
  lastSeenTurnIndex: number | null;
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
  if (isSchedulable(deps.warnMs)) scheduleWarn(timers, deps);
  if (isSchedulable(deps.maxMs)) scheduleWall(timers, deps);
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
  if (!isSchedulable(deps.warnMs)) return;
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
    // Activity must have happened since the last check — resume polling.
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
  // Do NOT re-arm here: re-arming while idleElapsed >= warnMs would busy-loop
  // via setTimeout(0). `onActivity` re-arms the warn cycle after recovery, so
  // subsequent idle stretches still get a fresh warning + termination window.
}

function scheduleTerm(timers: Timers, deps: TimerDeps): void {
  if (!isSchedulable(deps.terminateMs)) return;
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
    // Activity (or a tool call) reset the idle clock — reschedule for the
    // remaining time in the current idle stretch so we still terminate if
    // the stream goes idle again and stays idle.
    scheduleTerm(timers, deps);
    return;
  }
  terminate(deps, "idle", elapsed);
}

function scheduleWall(timers: Timers, deps: TimerDeps): void {
  if (!isSchedulable(deps.maxMs)) return;
  timers.wallTimer = setTimeout(() => {
    timers.wallTimer = null;
    if (deps.state.terminated !== null) return;
    const elapsed = deps.now() - deps.startedAt;
    terminate(deps, "wall_clock", elapsed);
  }, deps.maxMs);
}

/**
 * Emit the termination envelope in a single synchronous burst:
 *
 *   1. `custom: activity.terminated.*`  — telemetry marker.
 *   2. `tool_result` for every pending (post-`tool_call_end`) tool with an
 *      error payload — prevents orphaned `tool_call_start`/`tool_call_end`
 *      records in transcripts and closes the tool lifecycle even if the
 *      non-cooperative adapter never emits a late `tool_result` itself.
 *   3. `turn_end` with `stopBlocked: true` when mid-turn — same marker the
 *      engine already uses for stop-gate vetoes so `onAfterTurn` middleware
 *      that inspects `ctx.stopBlocked` will NOT persist the turn as a real
 *      completion. Turn-boundary consumers (CLI transcript bridge, session
 *      persistence) still see the event and can flush staged state.
 *   4. Terminal synthesized `done` with `stopReason: "interrupted"` and
 *      `metadata.metricsSynthesized: true` so persistence layers know the
 *      usage numbers are placeholders.
 *
 * Finally, the inner adapter is aborted with `AbortReason: "timeout"`.
 * Idempotent — guarded by `state.terminated` at each call site.
 */
function terminate(deps: TimerDeps, reason: ActivityTerminationReason, elapsed: number): void {
  deps.state.terminated = { reason, elapsedMs: elapsed };
  const customType = reason === "idle" ? ACTIVITY_TERMINATED_IDLE : ACTIVITY_TERMINATED_WALL_CLOCK;
  enqueue(deps.state, { kind: "custom", type: customType, data: { elapsedMs: elapsed } });

  for (const callId of deps.state.pendingTools) {
    // Conform to the existing TOOL_EXECUTION_ERROR payload contract used by
    // headless/CI consumers (see `packages/meta/cli/src/headless/run.ts`
    // `isToolExecutionError`): top-level `code` + top-level `error` string.
    // Extra fields (`synthesizedBy`, `terminationReason`) are additive and
    // carried through by anything that walks the full object.
    enqueue(deps.state, {
      kind: "tool_result",
      callId,
      output: {
        code: "TOOL_EXECUTION_ERROR",
        error: `Tool execution interrupted by activity timeout (${reason}) after ${elapsed}ms`,
        synthesizedBy: "activity-timeout",
        terminationReason: reason,
      },
    });
  }
  deps.state.pendingTools.clear();

  if (deps.state.currentTurnIndex !== null) {
    enqueue(deps.state, {
      kind: "turn_end",
      turnIndex: deps.state.currentTurnIndex,
      stopBlocked: true,
    });
    deps.state.currentTurnIndex = null;
  }
  enqueue(deps.state, synthesizeTerminalDone(deps.state, reason, elapsed));
  safeObserver(`onTerminated:${reason}`, () => deps.config.onTerminated?.(reason, elapsed));
  deps.ctl.abort("timeout" satisfies AbortReason);
}

/**
 * Synthesize a terminal `done` event so the wrapper honours the engine
 * contract that every stream ends with `kind: "done"`. Downstream consumers
 * (harness, loop, telemetry) key off `done.output.stopReason` and break if
 * the stream truncates after a custom event.
 *
 * Metrics are zeroed because the wrapper does not track token accounting — the
 * real counts live inside the adapter which has been aborted. The `metadata`
 * surface carries the termination reason so downstream can distinguish a
 * timeout-driven interrupt from a user-driven cancel.
 */
function synthesizeTerminalDone(
  state: WrapperState,
  reason: ActivityTerminationReason,
  elapsedMs: number,
): EngineEvent {
  // Every accounting field is zeroed so downstream aggregators that do NOT
  // inspect `metadata.metricsSynthesized` (e.g. `delivery-policy.ts`
  // RunReport persistence, the TUI cumulative metrics reducer, NDJSON
  // reporters) cannot be polluted by placeholder numbers. Consumers that
  // want real per-run observability for a timed-out stream should read
  // the metadata flags instead. `durationMs` is authoritative (measured)
  // so aggregating it is strictly correct.
  const output: EngineOutput = {
    content: [],
    stopReason: "interrupted",
    metrics: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      durationMs: elapsedMs,
    },
    metadata: {
      terminatedBy: "activity-timeout",
      terminationReason: reason,
      elapsedMs,
      // Token / turn counts above are synthetic zeros. Consumers that need
      // real observability for a timed-out run should key off these flags
      // rather than the metrics zeros.
      metricsSynthesized: true,
      // Highest turn index we observed before termination, or -1 if none.
      // Separate from metrics.turns so it doesn't inflate aggregates.
      lastSeenTurnIndex: state.lastSeenTurnIndex ?? -1,
    },
  };
  return { kind: "done", output };
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
  onActivity: (ev: EngineEvent) => void,
): Promise<void> {
  try {
    for await (const ev of adapter.stream(input)) {
      if (state.terminated !== null) break;
      onActivity(ev);
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
  } else if (ev.kind === "turn_start") {
    state.currentTurnIndex = ev.turnIndex;
    state.lastSeenTurnIndex =
      state.lastSeenTurnIndex === null
        ? ev.turnIndex
        : Math.max(state.lastSeenTurnIndex, ev.turnIndex);
  } else if (ev.kind === "turn_end") {
    state.currentTurnIndex = null;
    // NB: do NOT clear pendingTools here. Tools can legitimately keep running
    // past turn_end (the TUI has explicit coverage for this in
    // `packages/ui/tui/src/state/reduce.test.ts` — search for
    // "running tool after turn_end"). Clearing here would re-enter idle
    // accounting while a real tool is still working silently. pendingTools
    // stays set until the matching tool_result arrives or until the wall-
    // clock backstop fires.
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
