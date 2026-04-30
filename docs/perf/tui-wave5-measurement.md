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

On normal exit, the harness writes `./profile.json` (or whatever you set
`KOI_TUI_PROFILE_OUT` to). The path is announced on stderr.

## Probes

| Probe | Where | Question it answers |
|-------|-------|---------------------|
| `messagerow.mount` / `messagerow.cleanup` | `components/message-row.tsx` | Does Solid `<For>` unmount off-screen rows on scroll? |
| `batcher.flush.batchSize` | `batcher/event-batcher.ts` | How many events per flush? Is 16ms over- or under-coalescing? |
| `batcher.flush.gapMs` | `batcher/event-batcher.ts` | Actual interval between flushes |
| `batcher.flush.onFlushMs` | `batcher/event-batcher.ts` | How long does the store dispatch take per flush? |
| `cpu.userUs` / `cpu.systemUs` / `cpu.utilizationPct` (timestamped samples) | `profiling/cpu-sampler.ts` | End-to-end CPU during scenarios — picks up costs we can't see from inside `@koi/ui-tui` (e.g. `<scrollbox>` redraws, `<markdown>` parses) |

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
- `counters.messagerow.mount` ≈ message count → no virtualization at Solid layer (rows stay mounted)
- `counters.messagerow.cleanup` >> 0 during scroll → Solid `<For>` is virtualizing
- p95 of `samples["cpu.utilizationPct"]` **filtered to the scroll window** — if low, OpenTUI is already efficient; if high, the scrollbox is redrawing all rows. Filter samples to only those whose `t` falls between scroll-start and scroll-end (mark these timestamps before/after sending PageUp/PageDown).

**Verdict thresholds** (windowed p95):
- p95 CPU < 15% during pure scroll → **don't virtualize** (mutable store is enough).
- p95 CPU > 40% → consider virtualization in `message-list.tsx`.
- 15–40% → inconclusive; instrument OpenTUI scrollbox before deciding.

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

**Verdict thresholds** (windowed):
- p95 CPU during code-block scroll close to baseline idle → **no LRU needed**.
- p95 CPU >> baseline (3×+) → likely re-parsing on scroll; **consider LRU cache**.

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
