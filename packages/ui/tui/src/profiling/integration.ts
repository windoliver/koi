/**
 * Integration glue — one-shot init that the TUI entrypoint calls. Wires the
 * CPU sampler and registers a `process.on("exit")` handler that flushes the
 * profile report to disk.
 *
 * Idempotent: a second initProfiling() call is a no-op so we don't double-
 * register exit handlers if the TUI re-enters createTuiApp.
 *
 * Output path: `KOI_TUI_PROFILE_OUT` (default `./koi-tui-profile.json`).
 *
 * Disabled path: zero work — `isProfilingEnabled()` is checked first.
 */

import { writeFileSync } from "node:fs";
import { type CpuSamplerOptions, startCpuSampler, stopCpuSampler } from "./cpu-sampler.js";
import { dumpProfile, isProfilingEnabled } from "./profiler.js";

const DEFAULT_OUT_PATH = "./koi-tui-profile.json";

export interface InitProfilingOptions {
  /** Injectable for tests. */
  readonly processOn?: typeof process.on;
  /** Forwarded to startCpuSampler — used by tests to avoid real timers. */
  readonly cpuSamplerOptions?: CpuSamplerOptions;
}

// `let` justified: idempotency latch
let initialized = false;

export function initProfiling(options?: InitProfilingOptions): void {
  if (initialized) return;
  if (!isProfilingEnabled()) return;
  initialized = true;

  const onProcess = options?.processOn ?? process.on.bind(process);
  startCpuSampler(options?.cpuSamplerOptions);

  onProcess("exit", () => {
    stopCpuSampler();
    const report = dumpProfile();
    const path = process.env.KOI_TUI_PROFILE_OUT ?? DEFAULT_OUT_PATH;
    try {
      writeFileSync(path, JSON.stringify(report, null, 2));
      // Surface the path so users can find the report.
      process.stderr.write(`[koi-tui-profile] report written to ${path}\n`);
    } catch (err) {
      process.stderr.write(`[koi-tui-profile] failed to write ${path}: ${String(err)}\n`);
    }
  });
}

/** Test-only: clear the idempotency latch. Not exported from the package. */
export function __resetProfilingForTests(): void {
  initialized = false;
}
