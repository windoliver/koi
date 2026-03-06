# @koi/failure-context — Failure Classification Primitives (L0u)

Shared utilities for failure tracking and statistical analysis: bounded history trimming, running stats bridge from `@koi/welford-stats`, and a generic failure detector interface. Used by `@koi/agent-monitor` (anomaly detection) and `@koi/middleware-semantic-retry` (retry history).

---

## Why It Exists

Multiple packages reimplemented overlapping failure-related primitives:

1. **`@koi/agent-monitor`** — `buildLatencyStats()` bridge from WelfordState to `{ count, mean, stddev }`
2. **`@koi/middleware-semantic-retry`** — bounded history trimming (`trimRecords()`, 4 LOC)
3. **`@koi/middleware-feedback-loop`** — ring buffer with windowed metrics (not extracted — Rule of Three not yet met)

Extracting `computeRunningStats` and `trimToRecent` to a shared L0u package eliminates duplication and creates a canonical home for failure-related utilities.

---

## What This Enables

- **Canonical running stats bridge** — `computeRunningStats()` converts `WelfordState` (from `@koi/welford-stats`) to a `RunningStats` snapshot that any consumer can use without knowing about Welford internals.
- **Reusable bounded history** — `trimToRecent()` is a generic array window that works for any record type (retry records, anomaly signals, audit entries).
- **Shared detector contract** — `FailureDetector<TInput, TOutput>` provides a common interface for pluggable classification (threshold checks, ML scorers, pattern matchers).
- **Future extraction target** — When a second consumer needs ring buffers or windowed metrics from `@koi/middleware-feedback-loop`, this package is the natural home.

---

## API

### Types

#### `RunningStats`

```typescript
interface RunningStats {
  readonly count: number;
  readonly mean: number;
  readonly stddev: number;
}
```

Snapshot of streaming statistics. Replaces `@koi/agent-monitor`'s `LatencyStats` with a domain-neutral name.

#### `FailureRecordBase`

```typescript
interface FailureRecordBase {
  readonly timestamp: number;
}
```

Base type for any failure record that needs timestamp ordering.

#### `FailureDetector<TInput, TOutput>`

```typescript
interface FailureDetector<TInput, TOutput> {
  readonly detect: (input: TInput) => TOutput | null | Promise<TOutput | null>;
}
```

Generic classification contract. Returns `null` when no anomaly is detected.

### Functions

#### `computeRunningStats(state: WelfordState): RunningStats`

Bridge function: converts `WelfordState` (from `@koi/welford-stats`) into a `RunningStats` snapshot.

#### `trimToRecent<T>(records, maxSize): readonly T[]`

Keeps only the most recent `maxSize` entries. Returns the original array reference when within bounds (zero allocation).

---

## Layer Compliance

```
L0u @koi/welford-stats ─────────────────────────────────┐
    WelfordState, welfordStddev                          │
                                                         │
L0u @koi/failure-context ◄──────────────────────────────┘
    imports from @koi/core + @koi/welford-stats only

L2  @koi/agent-monitor ────────► @koi/failure-context
    computeRunningStats

L2  @koi/middleware-semantic-retry ─► @koi/failure-context
    trimToRecent
```

---

## File Structure

```
packages/lib/failure-context/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                  # Public exports
    ├── types.ts                  # FailureRecordBase, RunningStats
    ├── failure-detector.ts       # FailureDetector<TInput, TOutput>
    ├── running-stats.ts          # computeRunningStats (WelfordState → RunningStats)
    ├── running-stats.test.ts
    ├── bounded-history.ts        # trimToRecent<T>()
    └── bounded-history.test.ts
```
