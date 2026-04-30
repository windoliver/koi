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
import { resolve as resolvePath } from "node:path";
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
// Output path is captured at initProfiling() time so a mid-run change to
// KOI_TUI_PROFILE_OUT cannot redirect the current run's report into a
// different file (or overwrite an unrelated run's output) at flush time.
// `let` justified: assigned per-run by initProfiling, cleared by shutdown.
let activeOutPath: string | null = null;
// Frozen report snapshot for exit-handler retry. When shutdown's write
// fails, the live profiler state is still reset so probes are no-ops
// afterwards (preventing post-shutdown activity from contaminating the
// retained report). The snapshot retains the data + destination path
// independently of live state, so the registered exit handler retries
// against an immutable copy of the *original* run.
// `let` justified: assigned on write failure, cleared on success.
let pendingReportSnapshot: string | null = null;
let pendingReportPath: string | null = null;

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
  const wantsProfile = isProfilingRequestedByEnv();

  if (!wantsProfile) {
    // This caller did not ask for profiling. Two cases:
    // - No active profiled run: defensive cleanup (state.enabled may have
    //   leaked from a prior buggy path). Probes are no-ops afterwards.
    // - An active profiled run exists: do NOT touch state — that would
    //   wipe the active run's data. Return false and let this caller
    //   start without owning profiling. The active run's probes are
    //   process-global so its report may include this caller's activity
    //   (documented limitation), but blocking unrelated startups is worse.
    if (!runActive) resetProfiler({ enabled: false });
    return false;
  }

  // Caller wants profiling. Conflict only when another profiled run owns it.
  if (runActive) {
    throw new ProfilingConflictError();
  }

  // Fresh state for this run — must come before sampler start so the
  // sampler's first tick lands in a clean state map.
  resetProfiler({ enabled: true });
  runActive = true;
  writtenForRun = false;
  // Snapshot the destination NOW, resolved to an absolute path against the
  // *current* cwd. A later mutation of KOI_TUI_PROFILE_OUT or a
  // process.chdir() during the run cannot redirect this run's report.
  const rawPath = process.env.KOI_TUI_PROFILE_OUT ?? DEFAULT_OUT_PATH;
  activeOutPath = resolvePath(rawPath);

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
  // writeReportIfNeeded captures a snapshot for retry on failure, so
  // the live profiler state can always be reset here — post-shutdown
  // probe activity from any later unprofiled TUI cannot contaminate
  // the retained report.
  writeReportIfNeeded();
  resetProfiler({ enabled: false });
  runActive = false;
  activeOutPath = null;
}

function writeReportIfNeeded(): void {
  if (writtenForRun) return;
  // Two cases:
  //   (1) First attempt — serialize live state into a one-shot snapshot.
  //   (2) Retry — pendingReportSnapshot/Path are set from a prior failure.
  //       Live state may already have been reset; rely solely on the
  //       snapshot so post-shutdown activity cannot leak in.
  let serialized: string | null = pendingReportSnapshot;
  let path: string | null = pendingReportPath;
  if (serialized === null) {
    if (activeOutPath === null) return;
    serialized = JSON.stringify(dumpProfile(), null, 2);
    path = activeOutPath;
  }
  if (path === null) return;
  try {
    writeFileSync(path, serialized);
    writtenForRun = true;
    pendingReportSnapshot = null;
    pendingReportPath = null;
    process.stderr.write(`[koi-tui-profile] report written to ${path}\n`);
  } catch (err) {
    // Freeze the snapshot for a later retry (e.g. exit-handler).
    pendingReportSnapshot = serialized;
    pendingReportPath = path;
    process.stderr.write(`[koi-tui-profile] failed to write ${path}: ${String(err)}\n`);
  }
}

/** Test-only: clear all latches. Not exported from the package. */
export function __resetProfilingForTests(): void {
  runActive = false;
  writtenForRun = false;
  exitHandlerRegistered = false;
  activeOutPath = null;
  pendingReportSnapshot = null;
  pendingReportPath = null;
}
