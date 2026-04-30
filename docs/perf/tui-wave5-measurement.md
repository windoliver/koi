# TUI Wave 5 Measurement Protocol (#1586)

This doc describes the profiling harness landed in PR for issue #1586 and how
to run the scenarios it was built for. The harness is **diagnostic only** —
it does not change any runtime behavior unless `KOI_TUI_PROFILE=1`.

## Status

Profile-only. Whether to implement any of the three deferred Wave 5
optimizations (message virtualization, LRU markdown cache, faster batcher
flush interval) depends on the results captured below.

## Enabling

```bash
KOI_TUI_PROFILE=1 \
KOI_TUI_PROFILE_OUT=./profile.json \
bun run packages/meta/cli/src/bin.ts up
```

The report is written when the TUI's `stop()` runs (normal Ctrl+C quit).
A `process.on("exit")` fallback also writes if the process dies before
`stop()` completes. The path is announced on stderr.

CPU sampling cadence is **250ms** so sub-second scenario windows are
captured. A final synchronous tick is emitted at `stop()` so the trailing
partial interval is included.

**Limitations:**
- Profiling state is process-global. Running two profiled `createTuiApp`
  instances concurrently in the same process is rejected with a stderr
  warning ("already being profiled") rather than silently mixing reports.
  Profile sequentially or in separate processes.
- Per-metric storage is capped at 50,000 values. Exceeded only on multi-hour
  runs at saturated rates; further values are dropped silently.

## Probes

| Probe | Where | Question it answers |
|-------|-------|---------------------|
| `messagerow.mount` / `messagerow.cleanup` | `components/message-row.tsx` | Counts transcript mount / unmount events. **Does not** observe scroll virtualization (Solid `<For>` does not unmount on scroll — it unmounts only when the messages array changes, e.g. session clear). Useful as a baseline check that the transcript array is stable across a scroll scenario. |
| `batcher.flush.batchSize` | `batcher/event-batcher.ts` | How many events per flush? Is 16ms over- or under-coalescing? |
| `batcher.flush.gapMs` | `batcher/event-batcher.ts` | Start-to-start interval between flushes (independent of onFlush duration) |
| `batcher.flush.onFlushMs` | `batcher/event-batcher.ts` | How long does the store dispatch take per flush? |
| `cpu.userUs` / `cpu.systemUs` / `cpu.utilizationPct` (timestamped samples) | `profiling/cpu-sampler.ts` | End-to-end CPU during scenarios — picks up costs we can't see from inside `@koi/ui-tui` (e.g. `<scrollbox>` redraws, `<markdown>` parses). **This is the only signal that observes scroll-induced render cost.** |

### What CPU samples actually measure

`process.cpuUsage()` is **whole-process**: it includes any model streaming,
persistence I/O, MCP traffic, and other non-UI work running in the same
process as the TUI. Treat the CPU series as a **coarse process-level
signal**, not a renderer-isolated metric:

- A clean **idle** CPU baseline (no streaming, no scrolling) is the
  reliable control. Compare scrolling/streaming windows against this
  same-process baseline, not against absolute thresholds in isolation.
- A **delta** from baseline is more trustworthy than a windowed p95 by
  itself. e.g. "scroll p95 utilizationPct is +25 percentage points over
  idle" is meaningful evidence; "scroll p95 is 25%" alone is not.
- The verdict thresholds below are **suggestive**, not authoritative.
  They are only useful when paired with the baseline diff and a second
  signal (mount/cleanup counts, batcher histograms). A single CPU number
  should never drive a Wave 5 optimization decision on its own.
- For sharper UI-isolated measurements, instrument the OpenTUI render
  loop directly — out of scope for this PR.

### Histograms vs timestamped samples

The report has two storage shapes:

- `histograms` — global aggregates over the whole run. Used for **flush-bound** metrics (the batcher only emits while events are flowing, so the histogram already approximates "during streaming" without windowing).
- `samples` — `[timestampMs, value]` pairs, used for **time-driven** metrics (the CPU sampler ticks during idle too). Long idle tails would dilute global percentiles, so the protocol thresholds below operate on a windowed slice of `samples`.

Each scenario tells you which window to slice on. Use `performance.now()` (or wall-clock relative to the report timestamp) to mark scenario start/end before sending input.

### What is **not** measured (and why)

The Wave 5 questions about **render cost** and **markdown parse cost** live
inside OpenTUI internals (`<scrollbox>` redraw loop, `<markdown>` parser).
From within `@koi/ui-tui` we can only count Solid component lifecycle events
and watch end-to-end CPU. If the in-process probes don't reach a verdict,
the next step is OpenTUI-side instrumentation (out of scope here).

Specifically:

- We do **not** count off-screen `<box>` redraws. Solid components run their
  body once on mount; per-frame redraw cost is on OpenTUI's side.
- We do **not** count `<markdown>` parse invocations. Same reason.
- The CPU sampler captures the aggregate cost of those operations, so a
  high-CPU result on a scrolling-only scenario is evidence that further
  optimization (virtualization or LRU) is justified.

## Scenarios

Run each scenario with profiling enabled, capture `profile.json`, attach
results to the issue. All scenarios assume a session with reproducible
content (e.g. a recorded session loaded with `koi resume`).

### S1 — Long conversation scroll (M1 + CPU)

**Goal**: answer Decision 4A (virtualization).

1. Load or build a session with **500+ messages** (mix of text, code blocks).
2. Wait for the TUI to settle (`agentStatus = idle`).
3. PageUp 10 times, PageDown 10 times. Repeat 5 cycles.
4. Quit (Ctrl+C → confirm).

**Read**:
- `counters.messagerow.mount` should equal the loaded message count (sanity check: transcript wired correctly).
- `counters.messagerow.cleanup` should be **0** during a pure scroll (no session changes). A non-zero value indicates the transcript is mutating during the scenario — invalidates the run; restart and avoid actions that trigger session reload.
- p95 of `samples["cpu.utilizationPct"]` **filtered to the scroll window** — if low, OpenTUI is already efficient; if high, the scrollbox is redrawing all rows. Filter samples to only those whose `t` falls between scroll-start and scroll-end (mark these timestamps before/after sending PageUp/PageDown).
- Since neither Solid lifecycle counter observes virtualization, the windowed CPU figure is the **only** signal for this verdict.

**Verdict thresholds** (windowed p95, paired with same-process idle baseline):
- Scroll p95 within ~5pp of idle baseline → **don't virtualize** (the cost is not in the renderer).
- Scroll p95 > 25pp above baseline → likely renderer-bound; consider virtualization in `message-list.tsx`.
- 5–25pp delta → inconclusive; instrument OpenTUI scrollbox before deciding.

These deltas are guidance only — the CPU series is process-wide so any
concurrent streaming / persistence / MCP work shifts the baseline.

### S2 — Streaming burst (M3 + CPU)

**Goal**: answer Decision 16A (batcher interval).

1. Send a long prompt that produces 5–10s of streaming output with code
   blocks (e.g. "explain quicksort with a worked example in TypeScript").
2. Wait for completion.
3. Repeat 3×.
4. Quit.

**Read**:
- `histograms["batcher.flush.batchSize"]` p50, p95, max (no windowing — flushes only fire during streaming)
- `histograms["batcher.flush.gapMs"]` p50, p95
- `histograms["batcher.flush.onFlushMs"]` p50, p95
- `samples["cpu.utilizationPct"]` filtered to the streaming window (mark start/end timestamps)

**Verdict thresholds**:
- `batcher.flush.batchSize.p50` >> 1 (e.g. ≥ 5 events per flush) → 16ms is over-coalescing; **try 8ms**.
- `batcher.flush.batchSize.p50` ≈ 1 and `onFlushMs.p95` < 1ms → flushes are cheap; **don't change** the interval.
- Windowed `cpu.utilizationPct` p95 > 50% during streaming → batcher is not the bottleneck regardless; investigate elsewhere first.

### S3 — Code-block scroll (CPU only)

**Goal**: answer Decision 14A (LRU markdown cache).

1. Load a session with **20+ code-fence blocks** of ≥ 30 lines each.
2. PageUp through every code block, then PageDown back. Repeat 3×.
3. Quit.

**Read**:
- `samples["cpu.utilizationPct"]` filtered to the scroll window
  (compare to a separate baseline-idle window — sit idle for 5+ seconds before scrolling starts and use that as the control window)

**Verdict thresholds** (windowed, vs same-process idle baseline):
- p95 CPU during code-block scroll within ~5pp of baseline idle → **no LRU needed**.
- p95 CPU 3×+ baseline → likely re-parsing on scroll; **consider LRU cache**.

Same caveat: the metric is whole-process, so confirm no concurrent
streaming / persistence is running before drawing a conclusion.

## Reading `profile.json`

```json
{
  "counters": { "messagerow.mount": 543, "messagerow.cleanup": 41 },
  "histograms": {
    "batcher.flush.batchSize": { "count": 312, "min": 1, "max": 47, "mean": 4.2, "p50": 3, "p95": 12, "p99": 31 }
  },
  "samples": {
    "cpu.utilizationPct": [[1234.5, 3.8], [2234.6, 18.2], [3234.7, 12.1]]
  }
}
```

Each sample is `[timestampMs, value]` where `timestampMs` is `performance.now()` at record time. To compute a windowed p95, filter the array on `t` and sort by `value`. Percentiles in `histograms` use nearest-rank.

## Results

_(append findings here as scenarios are run — date, scenario, raw numbers, verdict)_
