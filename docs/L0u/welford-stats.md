# @koi/welford-stats — Welford's Online Algorithm for Running Statistics (L0u)

O(1) space, O(1) per-update running mean, variance, and standard deviation. No array growth, no numerical instability. Designed for streaming metrics in observability middleware.

---

## Why It Exists

Agent monitoring (`@koi/agent-monitor`) tracks per-session latency and token usage statistics to detect anomalous behavior (e.g., latency spikes, token floods). The naive approach — accumulating all values in an array and computing mean/stddev at query time — grows unbounded over long sessions and suffers from catastrophic cancellation with large values.

Welford's online algorithm solves both problems: it maintains a fixed 3-field state (`count`, `mean`, `m2`) and updates in O(1) per sample with numerically stable incremental updates. Extracting it into a shared L0u package makes the algorithm reusable by any package that needs streaming statistics — latency tracking, token budgeting, performance profiling, feedback-loop health scoring — without duplicating the math.

---

## What This Enables

- **Streaming anomaly detection** — `@koi/agent-monitor` uses `welfordUpdate` on every model call to maintain running latency/token stats, then `welfordStddev` to detect outliers (latency > mean + factor * stddev)
- **Bounded memory** — 3 numbers per metric stream, regardless of session length (hours, thousands of calls)
- **Numerical stability** — Welford's delta-based updates avoid the floating-point catastrophic cancellation that plagues naive sum-of-squares approaches, especially when values cluster around a large offset (e.g., latencies near 1,000,000ms)
- **Reusability** — any L1 or L2 package can import `@koi/welford-stats` for running statistics without reimplementing the algorithm

---

## API

### `WelfordState` (interface)

```typescript
interface WelfordState {
  readonly count: number;
  readonly mean: number;
  readonly m2: number;  // Sum of squared deviations from mean
}
```

### `WELFORD_INITIAL: WelfordState`

Frozen initial state: `{ count: 0, mean: 0, m2: 0 }`. Use as the starting accumulator.

### `welfordUpdate(state, value): WelfordState`

Returns a **new** `WelfordState` incorporating `value`. Never mutates the input.

### `welfordVariance(state): number`

Population variance (`m2 / count`). Returns `0` if `count < 2`.

### `welfordStddev(state): number`

Population standard deviation (`sqrt(m2 / count)`). Returns `0` if `count < 2`.

---

## How It Works

Each call to `welfordUpdate` performs 4 arithmetic operations:

```
delta  = value - old_mean
mean'  = old_mean + delta / count'
delta2 = value - mean'
m2'    = old_m2 + delta * delta2
```

The key insight: `delta` uses the old mean and `delta2` uses the new mean. Their product is an unbiased incremental contribution to the sum of squared deviations, avoiding the numerical instability of `sum(x²) - n * mean²`.

Reference: [Wikipedia — Welford's online algorithm](https://en.wikipedia.org/wiki/Algorithms_for_calculating_variance#Welford's_online_algorithm)

---

## Layer Compliance

```
L0u @koi/welford-stats
    ├── Zero imports (no @koi/* deps, no external deps)
    ├── Pure functions + readonly interface
    └── Importable by L1, L2, and L3
```

---

## File Structure

```
packages/lib/welford-stats/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts            # Public exports
    ├── welford.ts          # Algorithm implementation
    └── welford.test.ts     # 11 tests, 100% coverage
```
