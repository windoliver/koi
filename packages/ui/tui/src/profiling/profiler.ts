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

/** Timestamped (t, value) pair. `t` is `performance.now()` ms at record time. */
export type Sample = readonly [t: number, value: number];

export interface ProfileReport {
  readonly counters: Readonly<Record<string, number>>;
  readonly histograms: Readonly<Record<string, HistogramSummary>>;
  /**
   * Time-stamped samples — for metrics where post-hoc windowing matters
   * (e.g. CPU during a specific scrolling window). Histograms aggregate the
   * whole run; samples preserve enough resolution to compute statistics for
   * an arbitrary phase boundary.
   */
  readonly samples: Readonly<Record<string, ReadonlyArray<Sample>>>;
}

export interface ResetOptions {
  /** If omitted, falls back to `process.env.KOI_TUI_PROFILE === "1"`. */
  readonly enabled?: boolean;
}

/**
 * Cap on the number of timestamped samples retained per metric name. Prevents
 * unbounded growth on long sessions: at 1Hz CPU sampling, this caps memory at
 * ~13.9 hours of data per CPU metric — well past any realistic scenario.
 */
const SAMPLE_CAP_PER_METRIC = 50_000;

interface ProfilerState {
  enabled: boolean;
  readonly counters: Map<string, number>;
  readonly histograms: Map<string, number[]>;
  readonly samples: Map<string, Sample[]>;
}

function defaultEnabledFromEnv(): boolean {
  return process.env.KOI_TUI_PROFILE === "1";
}

function createState(enabled: boolean): ProfilerState {
  return { enabled, counters: new Map(), histograms: new Map(), samples: new Map() };
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

/**
 * Record a timestamped sample for `name`. Use for metrics where the consumer
 * needs to compute statistics over a specific time window (e.g. CPU during a
 * scroll-only window) — `recordHistogram` aggregates over the whole run and
 * cannot answer windowed questions.
 *
 * Capped at SAMPLE_CAP_PER_METRIC entries per metric; further samples are
 * dropped silently. The cap is large enough that realistic measurement
 * sessions never hit it.
 */
export function recordSample(name: string, value: number, t?: number): void {
  if (!state.enabled) return;
  const ts = t ?? performance.now();
  const existing = state.samples.get(name);
  if (existing) {
    if (existing.length >= SAMPLE_CAP_PER_METRIC) return;
    existing.push([ts, value]);
  } else {
    state.samples.set(name, [[ts, value]]);
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
  const samples: Record<string, ReadonlyArray<Sample>> = {};
  // Copy each samples array — callers may otherwise observe later mutations.
  for (const [k, v] of state.samples) samples[k] = v.slice();
  return { counters, histograms, samples };
}

export function resetProfiler(opts?: ResetOptions): void {
  const enabled = opts?.enabled ?? defaultEnabledFromEnv();
  state = createState(enabled);
}
