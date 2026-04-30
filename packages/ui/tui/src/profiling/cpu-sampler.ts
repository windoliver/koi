/**
 * CPU sampler — periodic process.cpuUsage deltas while profiling is enabled.
 *
 * Records four time-stamped sample series at `intervalMs` cadence (default 1s):
 *   - cpu.userUs        — user-space CPU microseconds per interval
 *   - cpu.systemUs      — kernel-space CPU microseconds per interval
 *   - cpu.wallMs        — wall-clock ms per interval (for context)
 *   - cpu.utilizationPct — (user+system) / wall, as percent (single core)
 *
 * Stored as `recordSample` (not `recordHistogram`) so consumers can compute
 * statistics over a specific scenario window — long idle tails would
 * otherwise dilute the global percentiles the protocol doc relies on.
 *
 * Drives the end-to-end Wave 5 (#1586) measurements: questions about render
 * cost / parse cost can't be answered from inside `@koi/ui-tui` (they live
 * inside OpenTUI). End-to-end CPU during scripted scenarios catches them.
 */

import { isProfilingEnabled, recordSample } from "./profiler.js";

type IntervalHandle = ReturnType<typeof setInterval>;

export interface CpuSamplerOptions {
  /** Sample interval. Default 1000ms. */
  readonly intervalMs?: number;
  /** Injectable scheduler for tests. */
  readonly setIntervalFn?: typeof setInterval;
  /** Injectable canceller for tests. */
  readonly clearIntervalFn?: typeof clearInterval;
}

// `let` justified: mutable timer state, swapped on start/stop
let timer: IntervalHandle | null = null;
let cancel: typeof clearInterval = clearInterval;

export function startCpuSampler(options?: CpuSamplerOptions): void {
  if (!isProfilingEnabled()) return;
  if (timer !== null) return; // already running
  const intervalMs = options?.intervalMs ?? 1000;
  const schedule = options?.setIntervalFn ?? setInterval;
  cancel = options?.clearIntervalFn ?? clearInterval;

  // `let` justified: rolling baselines updated on each tick
  let lastCpu = process.cpuUsage();
  let lastT = performance.now();

  timer = schedule(() => {
    const delta = process.cpuUsage(lastCpu);
    const now = performance.now();
    const wallMs = now - lastT;
    // All four series share the same `now` timestamp so consumers can window
    // on any one and read the others at the same point.
    recordSample("cpu.userUs", delta.user, now);
    recordSample("cpu.systemUs", delta.system, now);
    recordSample("cpu.wallMs", wallMs, now);
    if (wallMs > 0) {
      recordSample("cpu.utilizationPct", ((delta.user + delta.system) / 1000 / wallMs) * 100, now);
    }
    lastCpu = process.cpuUsage();
    lastT = now;
  }, intervalMs);
}

export function stopCpuSampler(): void {
  if (timer === null) return;
  cancel(timer);
  timer = null;
}
