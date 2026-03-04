# @koi/forge-demand — Demand-Triggered Forge Detection

`@koi/forge-demand` is an L2 middleware package that detects when forging new tools is needed and emits demand signals. It enables pull-based forging: the system detects environmental pressure (repeated failures, capability gaps, latency degradation) and triggers adaptation automatically.

---

## Why It Exists

Previously, forging was purely push-based — the LLM had to explicitly call `forge_tool`. There was no mechanism for the system to detect when forging is needed. The `maxForgesPerSession` limit is count-based, but count doesn't correlate with need.

```
Before (push-based):
  LLM → "I should forge a tool" → forge_tool call → new brick
  Problem: LLM must notice the need, count-based limits miss actual demand

After (pull-based, demand-triggered):
  tool fails 3x → demand signal emitted → auto-forge pipeline → pioneer brick
  capability gap detected → demand signal → forge adapts to environment
  latency degrades → demand signal → alternative tool forged
```

Inspired by **punctuated equilibrium**: long stasis with brief adaptation bursts when environmental pressure demands it.

---

## Architecture

### Layer position

```
L0  @koi/core               ─ ForgeTrigger, ForgeDemandSignal, ForgeBudget, ToolHealthSnapshot
L0u @koi/errors              ─ extractMessage for error handling
L0u @koi/validation          ─ validateWith for config validation
L2  @koi/forge-demand        ─ this package (depends on L0 + L0u only)
```

### Signal flow

```
┌──────────────────────────────────────────────────────────────┐
│                   Demand Detection Pipeline                   │
│                                                               │
│   wrapToolCall (priority 455):                                │
│     ├── tool NOT_FOUND → emit no_matching_tool trigger        │
│     │   └── immediate signal (no consecutive count needed)    │
│     ├── tool fails → increment consecutive failure counter    │
│     │   └── threshold reached → detectRepeatedFailure         │
│     │       └── emit ForgeDemandSignal                        │
│     ├── tool succeeds → reset failure counter                 │
│     └── check health tracker → detectLatencyDegradation       │
│                                                               │
│   wrapModelCall (priority 455):                               │
│     ├── scan response text for capability gap patterns        │
│     │   └── pattern matched → detectCapabilityGap             │
│     │       └── threshold reached → emit ForgeDemandSignal    │
│     └── fast-path: skip if no patterns or empty response      │
│                                                               │
│   Signal queue (bounded, max 10):                             │
│     ├── cooldown per trigger key                              │
│     ├── confidence scoring via computeDemandConfidence         │
│     └── dismiss(signalId) clears signal + cooldown            │
│                                                               │
│   Consumer (auto-forge-middleware):                            │
│     └── reads signals → forges pioneer bricks                 │
└──────────────────────────────────────────────────────────────┘
```

### Module map

```
forge-demand/src/
├── types.ts              ─ ForgeDemandConfig, ForgeDemandHandle, HeuristicThresholds
├── heuristics.ts         ─ Pure detection functions (no state, no side effects)
├── confidence.ts         ─ Confidence scoring algorithm
├── demand-detector.ts    ─ Middleware factory (createForgeDemandDetector)
├── config.ts             ─ Zod validation, defaults, createDefaultForgeDemandConfig
└── index.ts              ─ Public exports
```

---

## Heuristics

Four independent, pure detection functions — each takes inputs and returns `ForgeTrigger | undefined`:

### No matching tool

Triggers immediately when a tool call targets a nonexistent tool (`NOT_FOUND` error from `KoiRuntimeError`). Unlike `repeated_failure`, this fires on the first attempt — the tool doesn't exist, so there's no point counting retries.

```typescript
// wrapToolCall catches KoiRuntimeError with code "NOT_FOUND"
// → { kind: "no_matching_tool", query: toolId, attempts: 1 }
```

Uses `capability_gap` base weight (0.8). Cooldown key: `nmt:<toolId>`. Does **not** increment the `consecutiveFailures` counter (the tool never existed, it didn't "fail").

This heuristic connects to the engine's `discovery:miss` event — when the engine can't find a tool, it yields `discovery:miss`, and when the demand detector's `wrapToolCall` catches the same `NOT_FOUND` error, it emits `no_matching_tool` to trigger auto-forge.

### Repeated failure

Triggers when a tool fails consecutively more than `repeatedFailureCount` (default: 3).

```typescript
detectRepeatedFailure(toolId, consecutiveFailures, threshold)
// → { kind: "repeated_failure", toolName, count } | undefined
```

### Capability gap

Scans model response text against regex patterns indicating the LLM can't find a suitable tool.

```typescript
detectCapabilityGap(responseText, patterns, gapCounts, threshold)
// → { kind: "capability_gap", requiredCapability } | undefined
```

Default patterns match phrases like:
- "I don't have a tool for that"
- "No available tool to handle this"
- "I lack the capability to..."
- "There is no tool for..."

### Latency degradation

Checks health snapshot metrics against a p95 threshold (default: 5000ms).

```typescript
detectLatencyDegradation(toolId, healthSnapshot, p95ThresholdMs)
// → { kind: "performance_degradation", toolName, metric } | undefined
```

---

## Confidence Scoring

Each demand signal includes a confidence score (0–1) computed from:

```
confidence = baseWeight × severity
```

| Trigger kind | Base weight | Severity formula |
|-------------|-------------|-----------------|
| `repeated_failure` | 0.9 | `min(failureCount / threshold, 2.0)` |
| `no_matching_tool` | 0.8 | `min(failureCount / threshold, 2.0)` |
| `capability_gap` | 0.8 | `min(occurrences / threshold, 2.0)` |
| `performance_degradation` | 0.6 | `min(latency / threshold, 2.0)` |

Confidence is clamped to `[0, 1]`. Signals below `demandThreshold` (default: 0.7) are suppressed.

---

## API Reference

### `createForgeDemandDetector(config)`

Factory that returns a `ForgeDemandHandle` bundling the middleware and signal query API.

```typescript
import { createForgeDemandDetector } from "@koi/forge-demand";

const handle = createForgeDemandDetector({
  budget: {
    maxForgesPerSession: 5,
    computeTimeBudgetMs: 120_000,
    demandThreshold: 0.7,
    cooldownMs: 30_000,
  },
  healthTracker: feedbackLoopHandle, // optional, from @koi/middleware-feedback-loop
  onDemand: (signal) => console.log("Demand signal:", signal.trigger.kind),
  onDismiss: (id) => console.log("Dismissed:", id),
});

// Register the middleware
agent.use(handle.middleware);

// Query pending signals
const signals = handle.getSignals();
handle.dismiss(signals[0]?.id ?? "");
```

### `ForgeDemandHandle`

```
readonly middleware: KoiMiddleware       ─ Register with the agent
readonly getSignals: () => ForgeDemandSignal[]  ─ Current pending signals
readonly dismiss: (signalId: string) => void     ─ Remove signal + reset cooldown
readonly getActiveSignalCount: () => number      ─ Pending signal count
```

### `validateForgeDemandConfig(raw)`

Validates unknown input into a fully resolved config with defaults.

```typescript
import { validateForgeDemandConfig } from "@koi/forge-demand";

const result = validateForgeDemandConfig(rawInput);
if (result.ok) {
  const config = result.value; // ForgeDemandConfig with all defaults resolved
}
```

### `createDefaultForgeDemandConfig(overrides?)`

Creates a config with sensible defaults, optionally merged with overrides.

---

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `budget` | `ForgeBudget` | required | Budget constraints for demand-triggered forging |
| `budget.maxForgesPerSession` | `number` | `5` | Hard cap on forges per session |
| `budget.computeTimeBudgetMs` | `number` | `120_000` | Total forge compute budget (ms) |
| `budget.demandThreshold` | `number` | `0.7` | Minimum confidence to emit a signal |
| `budget.cooldownMs` | `number` | `30_000` | Cooldown between signals per trigger key |
| `healthTracker` | `FeedbackLoopHealthHandle` | `undefined` | Health tracker for latency detection |
| `capabilityGapPatterns` | `RegExp[]` | 5 built-in patterns | Patterns matching capability gap responses |
| `heuristics.repeatedFailureCount` | `number` | `3` | Consecutive failures before triggering |
| `heuristics.capabilityGapOccurrences` | `number` | `2` | Gap pattern matches before triggering |
| `heuristics.latencyDegradationP95Ms` | `number` | `5_000` | Latency threshold (ms) |
| `maxPendingSignals` | `number` | `10` | Bounded signal queue size |
| `onDemand` | `(signal) => void` | `undefined` | Callback when signal emitted |
| `onDismiss` | `(id) => void` | `undefined` | Callback when signal dismissed |
| `clock` | `() => number` | `Date.now` | Clock function (testable) |

---

## Integration with Auto-Forge

The demand handle plugs into `createAutoForgeMiddleware` from `@koi/crystallize`:

```typescript
import { createAutoForgeMiddleware } from "@koi/crystallize/auto-forge-middleware";
import { createForgeDemandDetector } from "@koi/forge-demand";

const demandHandle = createForgeDemandDetector({ budget: DEFAULT_FORGE_BUDGET });

const autoForge = createAutoForgeMiddleware({
  crystallizeHandle,
  forgeStore,
  scope: "session",
  demandHandle,             // enables demand-triggered forging
  onDemandForged: (signal, brick) => {
    console.log(`Pioneer brick forged: ${brick.name} from ${signal.trigger.kind}`);
  },
});
```

When a demand signal exceeds the budget threshold:
1. A **pioneer brick** is created with `tags: ["demand-forged", "pioneer"]`
2. Trust starts at `"sandbox"`, lifecycle at `"active"`
3. Provenance records `buildType: "koi.demand/pioneer/v1"` with trigger context
4. The signal is dismissed after the forge attempt

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Separate L2 package** (not bolted onto feedback-loop) | Single responsibility; demand detection is orthogonal to health tracking |
| **Handle pattern** (middleware + query API) | Follows `CrystallizeHandle` precedent; keeps state encapsulated |
| **Pure heuristic functions** | Independently testable, no side effects, composable |
| **Bounded signal queue** (max 10) | Prevents unbounded memory growth; oldest evicted |
| **Cooldown per trigger key** | Prevents duplicate signal spam for the same failure pattern |
| **Health types promoted to L0** | Enables demand detector to consume health snapshots without L2→L2 imports |
| **Pioneer tagging** (not a new brick kind) | Uses existing `tags` + `provenance` fields; no schema changes needed |
| **Confidence scoring** | Weighted formula per trigger kind; prevents low-quality signals from triggering forges |
| **Fire-and-forget forge** | Demand-triggered forges run asynchronously, never on the hot path |

---

## Layer Compliance

- [x] Imports only from `@koi/core` (L0) and L0u utilities (`@koi/errors`, `@koi/validation`)
- [x] No imports from `@koi/engine` (L1) or peer L2 packages
- [x] All interface properties are `readonly`
- [x] No `any`, no `enum`, no `class`, no `as Type` assertions in production code
- [x] ESM-only with `.js` extensions in all import paths
- [x] `check:layers` passes with zero violations
