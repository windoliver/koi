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
import { dumpProfile, isProfilingEnabled, resetProfiler } from "./profiler.js";

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

export function initProfiling(options?: InitProfilingOptions): void {
  if (runActive) {
    // Concurrent profiled createTuiApp() — profiling state is process-global
    // so a second app would silently mix metrics into the active run's
    // report and the first stop() would truncate the second app's data.
    // Surface the conflict instead of corrupting either run.
    if (isProfilingEnabled()) {
      process.stderr.write(
        "[koi-tui-profile] another TUI run is already being profiled; " +
          "this run's metrics will not be recorded. Run profiled TUIs sequentially " +
          "or in separate processes.\n",
      );
    }
    return;
  }
  if (!isProfilingEnabled()) return;

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
