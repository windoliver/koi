/**
 * Integration glue — binds profiling lifecycle to a TUI run.
 *
 * `initProfiling()` is called from `createTuiApp` after the TTY guard. It
 * resets profile state for this run, starts the CPU sampler, and registers
 * a fallback `process.on("exit")` flush in case the process dies before
 * the TUI's own `stop()` calls `shutdownProfiling()`.
 *
 * `shutdownProfiling()` is called from `TuiAppHandle.stop()`. It stops the
 * sampler and writes the report immediately, so subsequent createTuiApp
 * calls in the same process get fresh measurements (the sampler would
 * otherwise keep ticking through idle time and contaminate the next run).
 *
 * The exit handler is registered exactly once per process — subsequent
 * runs reuse it. A `writtenForRun` flag keeps it idempotent so it does
 * not double-write after a normal shutdown.
 *
 * Output path: `KOI_TUI_PROFILE_OUT` (default `./koi-tui-profile.json`).
 * Multiple runs in one process overwrite the same file unless the env
 * var is changed between runs.
 *
 * Disabled path: zero work — `isProfilingEnabled()` is checked first.
 */

import { writeFileSync } from "node:fs";
import { type CpuSamplerOptions, startCpuSampler, stopCpuSampler } from "./cpu-sampler.js";
import { dumpProfile, resetProfiler } from "./profiler.js";

/**
 * Read the env each time. The profiler's `state.enabled` flag is a runtime
 * "currently recording" marker that persists across init/shutdown and is
 * not authoritative for the question "should this run be profiled" — using
 * it as the gate would let profiling leak into runs after KOI_TUI_PROFILE
 * is unset, silently adding overhead and report writes.
 */
function isProfilingRequestedByEnv(): boolean {
  return process.env.KOI_TUI_PROFILE === "1";
}

const DEFAULT_OUT_PATH = "./koi-tui-profile.json";

export interface InitProfilingOptions {
  /** Injectable for tests. */
  readonly processOn?: typeof process.on;
  /** Forwarded to startCpuSampler — used by tests to avoid real timers. */
  readonly cpuSamplerOptions?: CpuSamplerOptions;
}

// `let` justified: per-run lifecycle latches
let runActive = false;
let writtenForRun = false;
let exitHandlerRegistered = false;

/**
 * Sentinel error class so callers can identify conflict rejections without
 * string-matching the message.
 */
export class ProfilingConflictError extends Error {
  constructor() {
    super(
      "[koi-tui-profile] another TUI run is already being profiled. " +
        "Profiling state is process-global; run profiled TUIs sequentially " +
        "or in separate processes.",
    );
    this.name = "ProfilingConflictError";
  }
}

/**
 * Conflict detection runs even when the current env says profiling is off.
 * That covers the case where a long-lived process turns profiling off mid-
 * way: a still-running profiled TUI must not be silently mixed with a
 * newly-starting unprofiled TUI's activity. The non-profiled run is
 * rejected so the active run stays clean.
 *
 * For the common case (env off, no run active), this is a fast path that
 * never throws.
 */

/**
 * Try to start profiling for the calling TUI run.
 *
 * Returns `true` when this call took ownership of the global profiler
 * state — the caller must invoke `shutdownProfiling()` exactly once when
 * the run ends (whether via normal stop or aborted start).
 *
 * Returns `false` when profiling is disabled (KOI_TUI_PROFILE!=1).
 *
 * Throws `ProfilingConflictError` when another run already owns profiling.
 * Throwing rather than warning prevents the second TUI from ever mounting,
 * so its probes (`MessageRow`, batcher, sampler) cannot contaminate the
 * active run's report — the global `state.enabled` flag would otherwise
 * accept writes from anyone.
 *
 * A non-owning caller (return false) MUST NOT call shutdownProfiling() —
 * doing so would tear down the active run's measurement.
 */
export function initProfiling(options?: InitProfilingOptions): boolean {
  if (runActive) {
    throw new ProfilingConflictError();
  }
  // Gate on the *current* env, not the profiler's runtime state. Otherwise
  // profiling latches on after the first profiled run because state.enabled
  // is set true by run 1's resetProfiler() and never cleared.
  if (!isProfilingRequestedByEnv()) {
    // Defensive: if state.enabled was somehow left true (e.g. a test
    // forgot to clean up), wipe it so probes are no-ops in this
    // non-profiled run.
    resetProfiler({ enabled: false });
    return false;
  }

  // Fresh state for this run — must come before sampler start so the
  // sampler's first tick lands in a clean state map.
  resetProfiler({ enabled: true });
  runActive = true;
  writtenForRun = false;

  startCpuSampler(options?.cpuSamplerOptions);

  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    const onProcess = options?.processOn ?? process.on.bind(process);
    onProcess("exit", () => writeReportIfNeeded());
  }
  return true;
}

/**
 * End the current profiling run: stop the sampler, flush the report, and
 * reset the run latch so the next createTuiApp() in this process can
 * start a clean measurement.
 *
 * Idempotent — safe to call from `TuiAppHandle.stop()` even when
 * profiling was not enabled.
 */
export function shutdownProfiling(): void {
  if (!runActive) return;
  stopCpuSampler();
  writeReportIfNeeded();
  // Disable probes so any stray batcher / sampler call between now and the
  // next initProfiling() is a no-op rather than silently writing into the
  // already-flushed state.
  resetProfiler({ enabled: false });
  runActive = false;
}

function writeReportIfNeeded(): void {
  if (writtenForRun) return;
  writtenForRun = true;
  const report = dumpProfile();
  const path = process.env.KOI_TUI_PROFILE_OUT ?? DEFAULT_OUT_PATH;
  try {
    writeFileSync(path, JSON.stringify(report, null, 2));
    process.stderr.write(`[koi-tui-profile] report written to ${path}\n`);
  } catch (err) {
    process.stderr.write(`[koi-tui-profile] failed to write ${path}: ${String(err)}\n`);
  }
}

/** Test-only: clear all latches. Not exported from the package. */
export function __resetProfilingForTests(): void {
  runActive = false;
  writtenForRun = false;
  exitHandlerRegistered = false;
}
