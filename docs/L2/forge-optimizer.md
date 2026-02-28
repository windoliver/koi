# @koi/forge-optimizer — Statistical Brick Optimization

`@koi/forge-optimizer` is an L2 package that evaluates crystallized composite tools against their component tools using statistical A/B testing. It keeps tools that improve performance and deprecates ones that don't.

---

## Why It Exists

Auto-forged composite tools aren't always better than calling the individual tools. A composite might add overhead, couple steps that are better left independent, or simply not be used enough to justify its existence. The optimizer answers: **"Is this composite tool actually worth keeping?"**

```
Composite tool: fetch-parse-save
  successRate: 85%    avgLatency: 200ms

Component tools (individually):
  fetch:  successRate: 95%    avgLatency: 50ms
  parse:  successRate: 98%    avgLatency: 30ms
  save:   successRate: 99%    avgLatency: 40ms
  aggregate: 92% success, 120ms total

Verdict: composite is WORSE (85% < 92%) → deprecate
```

---

## Architecture

### Layer position

```
L0  @koi/core                ─ ForgeStore, BrickArtifact, BrickFitnessMetrics
L2  @koi/forge-optimizer     ─ this package (depends on L0 only)
```

### Optimization loop

```
┌────────────────────────────────────────────────────────────┐
│                    Session lifecycle                        │
│                                                            │
│   Agent uses tools...                                      │
│     ├── composite: fetch-parse-save  ← fitness tracked     │
│     ├── individual: fetch            ← fitness tracked     │
│     ├── individual: parse            ← fitness tracked     │
│     └── individual: save             ← fitness tracked     │
│                                                            │
│   onSessionEnd (priority 990):                             │
│     ┌───────────────────────────────────────┐              │
│     │  Optimizer sweep                      │              │
│     │                                       │              │
│     │  For each crystallized brick:         │              │
│     │    1. Load fitness metrics            │              │
│     │    2. Compute composite fitness       │              │
│     │    3. Load component tool fitness     │              │
│     │    4. Compute aggregate fitness       │              │
│     │    5. Compare with threshold          │              │
│     │                                       │              │
│     │  Result:                              │              │
│     │    keep      → no action              │              │
│     │    deprecate → update lifecycle       │              │
│     └───────────────────────────────────────┘              │
└────────────────────────────────────────────────────────────┘
```

---

## API Reference

### `computeFitnessScore(fitness, now, evaluationWindowMs)`

Pure function that computes a fitness score from `BrickFitnessMetrics`:

```
score = successRate × (1 / avgLatencyMs) × recencyFactor
```

- `successRate = successCount / (successCount + errorCount)`
- `avgLatencyMs` from the brick's `LatencySampler`
- `recencyFactor` decays based on time since last use

### `createBrickOptimizer(config)`

Factory that returns a `BrickOptimizer` with `evaluate` and `sweep`.

```typescript
import { createBrickOptimizer } from "@koi/forge-optimizer";

const optimizer = createBrickOptimizer({
  store: forgeStore,
  minSampleSize: 20,           // skip bricks with < 20 uses
  improvementThreshold: 0.1,   // 10% improvement required
  evaluationWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
});

// Evaluate a single brick
const result = await optimizer.evaluate(brickId);
// → { brickId, action: "keep" | "deprecate", fitnessOriginal, reason }

// Sweep all crystallized bricks
const results = await optimizer.sweep();
for (const r of results) {
  console.log(`${r.brickId}: ${r.action} — ${r.reason}`);
}
```

**Config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `store` | `ForgeStore` | required | Store to query and update bricks |
| `minSampleSize` | `number` | `20` | Skip bricks with fewer uses |
| `improvementThreshold` | `number` | `0.1` | Required fitness improvement (10%) |
| `evaluationWindowMs` | `number` | `7 days` | Evaluation time window |
| `clock` | `() => number` | `Date.now` | Clock function (testable) |

### `createOptimizerMiddleware(config)`

Middleware that runs `sweep()` on `onSessionEnd` (priority 990):

```typescript
import { createOptimizerMiddleware } from "@koi/forge-optimizer";

const middleware = createOptimizerMiddleware({
  store: forgeStore,
  onResults: (results) => {
    for (const r of results) {
      console.log(`${r.action}: ${r.brickId}`);
    }
  },
});
```

---

## Design Decisions

1. **Session-end evaluation** — Sweep runs on `onSessionEnd`, not on the hot path. No impact on response latency.
2. **Minimum sample size** — Bricks with fewer than `minSampleSize` uses are skipped. Statistical conclusions from small samples are unreliable.
3. **Component aggregate** — Compares composite fitness against the aggregate of individual component tools, not a theoretical best case.
4. **Auto-deprecate only** — The optimizer deprecates underperformers but never deletes. Deprecated bricks can be restored if the decision was wrong.
5. **Provenance-based identification** — Crystallized bricks are identified by `provenance.source.origin === "forged"` and `buildType === "koi.crystallize/composite/v1"`.
