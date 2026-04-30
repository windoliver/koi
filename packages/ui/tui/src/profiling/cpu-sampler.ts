/**
 * CPU sampler — periodic process.cpuUsage deltas while profiling is enabled.
 *
 * Records four time-stamped sample series at `intervalMs` cadence (default 250ms):
 *   - cpu.userUs        — user-space CPU microseconds per interval
 *   - cpu.systemUs      — kernel-space CPU microseconds per interval
 *   - cpu.wallMs        — wall-clock ms per interval (for context)
 *   - cpu.utilizationPct — (user+system) / wall, as percent (single core)
 *
 * The 250ms default is fine-grained enough to capture sub-second scroll
 * and streaming bursts that 1Hz sampling would miss entirely. On stop,
 * a final synchronous sample is emitted so the trailing partial interval
 * (e.g. the last 200ms before the user quits) is preserved.
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
  /** Sample interval. Default 250ms — fine-grained enough for sub-second bursts. */
  readonly intervalMs?: number;
  /** Injectable scheduler for tests. */
  readonly setIntervalFn?: typeof setInterval;
  /** Injectable canceller for tests. */
  readonly clearIntervalFn?: typeof clearInterval;
}

// `let` justified: mutable timer state, swapped on start/stop
let timer: IntervalHandle | null = null;
let cancel: typeof clearInterval = clearInterval;
// `let` justified: captured tick closure, called once more on stop so the
// trailing partial interval (e.g. the last 200ms before quit) is recorded.
let captureFinalTick: (() => void) | null = null;

export function startCpuSampler(options?: CpuSamplerOptions): void {
  if (!isProfilingEnabled()) return;
  if (timer !== null) return; // already running
  const intervalMs = options?.intervalMs ?? 250;
  const schedule = options?.setIntervalFn ?? setInterval;
  cancel = options?.clearIntervalFn ?? clearInterval;

  // `let` justified: rolling baselines updated on each tick
  let lastCpu = process.cpuUsage();
  let lastT = performance.now();

  const tick = (): void => {
    const delta = process.cpuUsage(lastCpu);
    const now = performance.now();
    const wallMs = now - lastT;
    // Skip degenerate ticks (e.g. a final tick fired at the same instant
    // as the previous one) — they would record a 0ms wall and divide-by-zero
    // on utilizationPct.
    if (wallMs <= 0) return;
    // All four series share the same `now` timestamp so consumers can window
    // on any one and read the others at the same point.
    recordSample("cpu.userUs", delta.user, now);
    recordSample("cpu.systemUs", delta.system, now);
    recordSample("cpu.wallMs", wallMs, now);
    recordSample("cpu.utilizationPct", ((delta.user + delta.system) / 1000 / wallMs) * 100, now);
    lastCpu = process.cpuUsage();
    lastT = now;
  };

  captureFinalTick = tick;
  timer = schedule(tick, intervalMs);
}

export function stopCpuSampler(): void {
  if (timer === null) return;
  // Emit one synchronous final sample so the partial interval between the
  // last scheduled tick and stop() is preserved. Without this, scenarios
  // shorter than `intervalMs` could be entirely absent from the report.
  captureFinalTick?.();
  cancel(timer);
  timer = null;
  captureFinalTick = null;
}
