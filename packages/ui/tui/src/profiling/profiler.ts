/**
 * Profiler — opt-in instrumentation harness for TUI Wave 5 measurements (#1586).
 *
 * Gated by `KOI_TUI_PROFILE=1`. When disabled, every probe is a single
 * boolean check followed by an early return — zero allocation, no Map ops.
 *
 * Used by:
 *   - MessageRow lifecycle counters (virtualization question)
 *   - text-block markdown re-evaluation counter (LRU cache question)
 *   - event-batcher flush histograms (interval-tuning question)
 *
 * No file I/O lives here — callers (e.g. tui shutdown) call `dumpProfile()`
 * and decide where the report goes.
 */

export interface HistogramSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface ProfileReport {
  readonly counters: Readonly<Record<string, number>>;
  readonly histograms: Readonly<Record<string, HistogramSummary>>;
}

export interface ResetOptions {
  /** If omitted, falls back to `process.env.KOI_TUI_PROFILE === "1"`. */
  readonly enabled?: boolean;
}

interface ProfilerState {
  enabled: boolean;
  readonly counters: Map<string, number>;
  readonly histograms: Map<string, number[]>;
}

function defaultEnabledFromEnv(): boolean {
  return process.env.KOI_TUI_PROFILE === "1";
}

function createState(enabled: boolean): ProfilerState {
  return { enabled, counters: new Map(), histograms: new Map() };
}

// `let` justified: replaced wholesale by resetProfiler().
let state: ProfilerState = createState(defaultEnabledFromEnv());

export function isProfilingEnabled(): boolean {
  return state.enabled;
}

export function bumpCounter(name: string, by: number = 1): void {
  if (!state.enabled) return;
  state.counters.set(name, (state.counters.get(name) ?? 0) + by);
}

export function recordHistogram(name: string, value: number): void {
  if (!state.enabled) return;
  const existing = state.histograms.get(name);
  if (existing) {
    existing.push(value);
  } else {
    state.histograms.set(name, [value]);
  }
}

function nearestRank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function summarizeHistogram(values: readonly number[]): HistogramSummary {
  // Copy before sort — values may be reused if dump is called multiple times.
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const min = sorted[0] ?? 0;
  const max = sorted[count - 1] ?? 0;
  let sum = 0;
  for (const v of sorted) sum += v;
  const mean = count === 0 ? 0 : sum / count;
  return {
    count,
    min,
    max,
    mean,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
  };
}

export function dumpProfile(): ProfileReport {
  const counters: Record<string, number> = {};
  for (const [k, v] of state.counters) counters[k] = v;
  const histograms: Record<string, HistogramSummary> = {};
  for (const [k, v] of state.histograms) histograms[k] = summarizeHistogram(v);
  return { counters, histograms };
}

export function resetProfiler(opts?: ResetOptions): void {
  const enabled = opts?.enabled ?? defaultEnabledFromEnv();
  state = createState(enabled);
}
