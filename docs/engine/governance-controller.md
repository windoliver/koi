# Governance Controller

Unified cybernetic controller — one sensor per variable, one setpoint per sensor,
one `checkAll()` for the entire agent.

**Layer**: L0 types (`@koi/core`) + L1 runtime (`@koi/engine`) + L2 contributors
**Issue**: #261

---

## Overview

Every Koi agent has a governance controller that monitors resource consumption
and enforces limits. Instead of scattered guards each owning their own counters,
one controller tracks everything — turns, tokens, cost, duration, spawn depth,
error rate — through a unified sensor/setpoint model.

L2 packages contribute additional variables (e.g., forge depth, forge budget)
without touching L1 code.

```
┌─────────────────────────────────────────────────────┐
│              Governance Controller                    │
│                                                       │
│  Built-in sensors (L1):        L2-contributed:        │
│  ┌──────────┐ ┌──────────┐    ┌──────────┐           │
│  │ turns    │ │ tokens   │    │ forge    │           │
│  │  3/25    │ │ 12k/100k │    │ depth 1  │           │
│  └──────────┘ └──────────┘    └──────────┘           │
│  ┌──────────┐ ┌──────────┐    ┌──────────┐           │
│  │ duration │ │ cost     │    │ forge    │           │
│  │ 8s/300s  │ │ $0.02/$1 │    │ budget 3 │           │
│  └──────────┘ └──────────┘    └──────────┘           │
│  ┌──────────┐ ┌──────────┐                            │
│  │ errors   │ │ spawn    │     Any L2 can contribute  │
│  │ 0.1/0.5  │ │  2/5     │     via prefix query       │
│  └──────────┘ └──────────┘                            │
│                                                       │
│  checkAll() → first violation or { ok: true }         │
│  snapshot() → all readings + healthy flag             │
│  record()   → update counters from events             │
└─────────────────────────────────────────────────────┘
```

## What this replaces

Previously, governance was scattered:

| Before | Problem |
|--------|---------|
| `GovernanceComponent` (L0 ECS interface) | Minimal — only `usage()` and `checkSpawn()`. No production implementation |
| `checkGovernance()` (L2 forge standalone) | Separate counters, no shared state with L1 guards |
| Iteration guard (L1) | Owns its own turn/token/duration counters |
| Spawn guard (L1) | Reads `GovernanceComponent` but falls through when absent |

Now: one controller, one set of counters, one check surface.

## Key design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Abstraction | Numeric variable registry | Each variable = one sensor + one setpoint. Simple, extensible |
| Layer split | Types L0, controller L1, sensors L2 | Clean layer separation. L2 contributes without importing L1 |
| Registration | Assembly-time only, sealed after | No runtime surprises. Variable set is fixed before first turn |
| Concurrency | Single-threaded + frozen snapshots | JS guarantee. No locks needed |
| Async interface | `T \| Promise<T>` on all I/O methods | In-memory sync today, distributed async tomorrow |
| Builder/Controller | Builder (L1 only) has register/seal | L0 `GovernanceController` is runtime-only — no mutation surface |
| Error rate | Rolling time window (ring buffer) | Bounded memory, O(1) record, O(k) count |
| Cost tracking | Per-token pricing model | Configurable input/output rates, accumulates from real usage |
| L2 discovery | Generic ECS prefix query | Extension calls `agent.query("governance:contrib:")` — zero L2 knowledge |

---

## Architecture

### Layer separation

```
L0  @koi/core          L1  @koi/engine              L2  @koi/forge (etc.)
┌────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│                │     │                      │     │                      │
│ Governance     │◄────│ GovernanceController  │     │ ForgeGovernance      │
│ Controller     │     │ Builder              │     │ Contributor          │
│ (interface)    │     │ (implementation)     │     │                      │
│                │     │                      │     │ variables():         │
│ Governance     │◄────│ GovernanceProvider   │     │   forge_depth        │
│ Variable       │     │ (creates + attaches) │     │   forge_budget       │
│ (interface)    │     │                      │     │                      │
│                │     │ GovernanceExtension  │     │ Attached at:         │
│ Governance     │◄────│ (discovers + seals)  │     │ "governance:contrib: │
│ Variable       │     │                      │     │  forge"              │
│ Contributor    │     │ GovernanceReconciler │     │                      │
│ (interface)    │     │ (background drift)   │     │ Imports only from    │
│                │     │                      │     │ @koi/core (L0)       │
│ GOVERNANCE_    │     │ Rolling window       │     │                      │
│ VARIABLES      │     │ (error rate)         │     │                      │
│ (constants)    │     │                      │     │                      │
└────────────────┘     └──────────────────────┘     └──────────────────────┘
     L0 only                L0 + L0u only                 L0 only
```

### Assembly flow

The governance controller is wired during agent assembly in two phases:

```
Phase 1: Providers (attach components)     Phase 2: Extensions (discover + seal)
┌──────────────────────────┐               ┌──────────────────────────────────┐
│ GovernanceProvider (L1)  │               │ GovernanceExtension (L1)         │
│                          │               │                                  │
│ 1. create builder        │               │ 1. read builder from agent       │
│ 2. register 7 built-in   │               │    (GOVERNANCE component)        │
│    sensors               │               │                                  │
│ 3. attach as GOVERNANCE  │               │ 2. query("governance:contrib:")  │
│    component             │               │    → discovers ALL contributors  │
│                          │               │    → registers their variables   │
├──────────────────────────┤               │                                  │
│ ForgeProvider (L2)       │               │ 3. seal() — no more changes      │
│                          │               │                                  │
│ 1. create tools          │               │ 4. produce governance guard      │
│ 2. create contributor    │               │    middleware                     │
│    (forge_depth +        │               │                                  │
│     forge_budget vars)   │               │ Key: uses GENERIC prefix query   │
│ 3. attach at             │               │ — zero knowledge of forge or     │
│    "governance:contrib:  │               │ any specific L2 package          │
│     forge"               │               │                                  │
└──────────────────────────┘               └──────────────────────────────────┘

Component map is frozen after Phase 1. The builder object inside the map
is mutable — Phase 2 calls register() and seal() on it. After seal(),
only the runtime GovernanceController interface is available.
```

### Middleware chain

The governance guard produced by the extension intercepts every turn,
tool call, and model call:

```
                    ┌──────────────────────────────────────┐
                    │        Governance Guard (MW)          │
                    │        priority: 0 (outermost)        │
                    ├──────────┬───────────┬────────────────┤
                    │          │           │                │
              onBeforeTurn  wrapToolCall  wrapModelCall     │
                    │          │           │                │
                    ▼          ▼           ▼                │
              ┌──────────┐ ┌─────────┐ ┌──────────────┐    │
              │ record   │ │ spawn?  │ │ next(req)    │    │
              │  (turn)  │ │ check   │ │ record       │    │
              │ checkAll │ │  depth  │ │  token_usage │    │
              │  → ok?   │ │  count  │ │  (+ cost)    │    │
              │  → throw │ │ next()  │ │ return resp  │    │
              │   if not │ │ record  │ │              │    │
              └──────────┘ │ success │ └──────────────┘    │
                           │ or error│                     │
                           └─────────┘                     │
                    └──────────────────────────────────────┘
```

---

## L0 Types (`@koi/core/governance.ts`)

### GovernanceVariable

One sensor + one setpoint:

```typescript
interface GovernanceVariable {
  readonly name: string;
  readonly read: () => number;            // current sensor value
  readonly limit: number;                 // setpoint
  readonly check: () => GovernanceCheck;  // sensor vs setpoint
  readonly retryable: boolean;            // RATE_LIMIT vs PERMISSION
  readonly description?: string;
}
```

### GovernanceCheck

Discriminated union — callers decide throw vs. Result:

```typescript
type GovernanceCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly variable: string;
      readonly reason: string;
      readonly retryable: boolean;
    };
```

### GovernanceController

Runtime interface (no mutation surface):

```typescript
interface GovernanceController {
  readonly check: (variable: string) => GovernanceCheck | Promise<GovernanceCheck>;
  readonly checkAll: () => GovernanceCheck | Promise<GovernanceCheck>;
  readonly record: (event: GovernanceEvent) => void | Promise<void>;
  readonly snapshot: () => GovernanceSnapshot | Promise<GovernanceSnapshot>;
  readonly variables: () => ReadonlyMap<string, GovernanceVariable>;
  readonly reading: (variable: string) => SensorReading | undefined;
}
```

### GovernanceEvent

Events that update sensor state:

```typescript
type GovernanceEvent =
  | { readonly kind: "turn" }
  | { readonly kind: "spawn"; readonly depth: number }
  | { readonly kind: "spawn_release" }
  | { readonly kind: "forge"; readonly toolName?: string }
  | { readonly kind: "token_usage"; readonly count: number;
      readonly inputTokens?: number; readonly outputTokens?: number }
  | { readonly kind: "tool_error"; readonly toolName: string }
  | { readonly kind: "tool_success"; readonly toolName: string };
```

### GovernanceVariableContributor

L2 packages implement this to inject variables:

```typescript
interface GovernanceVariableContributor {
  readonly variables: () => readonly GovernanceVariable[];
}
```

### Well-known variable names

```typescript
const GOVERNANCE_VARIABLES = {
  SPAWN_DEPTH:  "spawn_depth",
  SPAWN_COUNT:  "spawn_count",
  TURN_COUNT:   "turn_count",
  TOKEN_USAGE:  "token_usage",
  DURATION_MS:  "duration_ms",
  FORGE_DEPTH:  "forge_depth",   // L2-contributed
  FORGE_BUDGET: "forge_budget",  // L2-contributed
  ERROR_RATE:   "error_rate",
  COST_USD:     "cost_usd",
} as const;
```

---

## L1 Runtime (`@koi/engine`)

### GovernanceControllerBuilder

L1-only extension of `GovernanceController` with mutation methods:

```typescript
interface GovernanceControllerBuilder extends GovernanceController {
  readonly register: (variable: GovernanceVariable) => void;
  readonly seal: () => void;
  readonly sealed: boolean;
}
```

After `seal()`, `register()` throws `KoiRuntimeError(VALIDATION)`.

### Built-in variables

Created by `createGovernanceController(config, options)`:

| Variable | read() | limit | Comparison | retryable |
|----------|--------|-------|------------|-----------|
| `spawn_depth` | agent depth (immutable) | `config.spawn.maxDepth` | `>` (equal is OK) | false |
| `spawn_count` | spawn counter | `config.spawn.maxFanOut` | `>=` (at limit = violation) | true |
| `turn_count` | turn counter | `config.iteration.maxTurns` | `>=` | false |
| `token_usage` | token counter | `config.iteration.maxTokens` | `>=` | false |
| `duration_ms` | `Date.now() - startedAt` | `config.iteration.maxDurationMs` | `>=` | false |
| `error_rate` | `errors / totalToolCalls` | `config.errorRate.threshold` | `>=` | true |
| `cost_usd` | accumulated cost | `config.cost.maxCostUsd` | `>=` (skip if 0) | false |

### record() dispatcher

```
record(event) → switch on event.kind:

  "turn"          → turnCount++
  "spawn"         → spawnCount++
  "spawn_release" → spawnCount = max(0, spawnCount - 1)
  "forge"         → (tracked by L2-contributed variables)
  "token_usage"   → tokenUsage += event.count
                     cost += inputTokens * $/tok + outputTokens * $/tok
  "tool_error"    → errorWindow.record(now); totalToolCalls++
  "tool_success"  → totalToolCalls++
```

### snapshot()

Returns a frozen point-in-time view of all variables:

```typescript
interface GovernanceSnapshot {
  readonly timestamp: number;
  readonly readings: readonly SensorReading[];
  readonly healthy: boolean;        // true when violations is empty
  readonly violations: readonly string[];  // names of failing variables
}

interface SensorReading {
  readonly name: string;
  readonly current: number;
  readonly limit: number;
  readonly utilization: number;  // current / limit, clamped 0-1
}
```

### GovernanceConfig

```typescript
interface GovernanceConfig {
  readonly spawn: {
    readonly maxDepth: number;       // default: 3
    readonly maxFanOut: number;      // default: 5
  };
  readonly iteration: {
    readonly maxTurns: number;       // default: 25
    readonly maxTokens: number;      // default: 100_000
    readonly maxDurationMs: number;  // default: 300_000
  };
  readonly errorRate: {
    readonly windowMs: number;       // default: 60_000
    readonly threshold: number;      // default: 0.5
  };
  readonly cost: {
    readonly maxCostUsd: number;     // default: 0 (disabled)
    readonly costPerInputToken: number;
    readonly costPerOutputToken: number;
  };
}
```

### Rolling window (error rate)

Pre-allocated circular buffer for bounded-memory error tracking:

```
capacity = 1000, windowMs = 60s

record():  buffer[cursor] = timestamp; cursor = (cursor+1) % capacity
count():   walk backwards from newest, stop at first outside window

  [t=10s]  [t=25s]  [t=41s]  [t=55s]  ← 4 errors in window at t=60s
                                          rate = 4 / totalToolCalls

  At t=71s: [t=10s] falls outside window → 3 errors in window
```

O(1) record, O(k) count where k = errors in window. Bounded by capacity.

---

## Runtime flow example

```
User: "Refactor the auth module"
      │
      ▼
┌─ Turn 0 ──────────────────────────────────────────────────────────┐
│  governance guard: record(turn) → turns=1                         │
│  governance guard: checkAll()   → ✓ all 7 variables within limits │
│                                                                    │
│  model call → "I'll read the files first..."                      │
│  governance guard: record(token_usage: 1200, in:800, out:400)     │
│                    cost += 800×$0.000001 + 400×$0.000005 = $0.003 │
│                                                                    │
│  tool call: read_file("auth.ts")                                  │
│  governance guard: record(tool_success)                           │
└────────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─ Turn 1 ──────────────────────────────────────────────────────────┐
│  governance guard: record(turn) → turns=2                         │
│  governance guard: checkAll()   → ✓ ok                            │
│                                                                    │
│  model call → "Here's the refactored code..."                     │
│  governance guard: record(token_usage: 3400, in:1800, out:1600)   │
│                    cost += $0.010                                  │
│                                                                    │
│  tool call: write_file("auth.ts")                                 │
│  governance guard: record(tool_success)                           │
└────────────────────────────────────────────────────────────────────┘
      │
      ▼
┌─ Turn 2 ──────────────────────────────────────────────────────────┐
│  governance guard: record(turn) → turns=3                         │
│  governance guard: checkAll()   → ✓ ok                            │
│                                                                    │
│  model call → "Done! Here's what I changed..."                    │
│  governance guard: record(token_usage: 800)                       │
│  no tool calls → final response                                   │
└────────────────────────────────────────────────────────────────────┘
      │
      ▼
  snapshot() → {
    healthy: true,
    readings: [
      { name: "turn_count",  current: 3,     limit: 25,     utilization: 0.12 },
      { name: "token_usage", current: 5400,  limit: 100000, utilization: 0.05 },
      { name: "cost_usd",   current: 0.013, limit: 1.00,   utilization: 0.01 },
      { name: "duration_ms", current: 8200,  limit: 300000, utilization: 0.03 },
      { name: "error_rate",  current: 0.0,   limit: 0.5,    utilization: 0.00 },
      ...
    ],
    violations: []
  }
```

## Limit hit scenario

```
┌─ Turn 24 ─────────────────────────────────────────────────────────┐
│  governance guard: record(turn) → turns=25                        │
│  governance guard: checkAll()   → ✗ FAIL                          │
│    "Turn count 25 reached limit 25"                               │
│                                                                    │
│  ┌───────────────────────────────────────────┐                    │
│  │  KoiRuntimeError(TIMEOUT)                 │                    │
│  │  → createKoi converts to done event       │                    │
│  │  → stopReason: "max_turns"                │                    │
│  │  → agent gracefully terminates            │                    │
│  └───────────────────────────────────────────┘                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## L2 contributor pattern

Any L2 package can contribute governance variables without importing L1:

```typescript
// In @koi/forge (L2) — imports only from @koi/core (L0)
import { governanceContributorToken, GOVERNANCE_VARIABLES } from "@koi/core";
import type { GovernanceVariable, GovernanceVariableContributor } from "@koi/core";

const FORGE_GOVERNANCE = governanceContributorToken("forge");

function createForgeGovernanceContributor(
  config: ForgeConfig,
  readDepth: () => number,
  readForgeCount: () => number,
): GovernanceVariableContributor {
  const forgeDepth: GovernanceVariable = {
    name: GOVERNANCE_VARIABLES.FORGE_DEPTH,
    read: readDepth,
    limit: config.maxForgeDepth,
    retryable: false,
    check: () => readDepth() > config.maxForgeDepth
      ? { ok: false, variable: "forge_depth", reason: "...", retryable: false }
      : { ok: true },
  };

  return { variables: () => [forgeDepth, /* forgeBudget */] };
}
```

The L2 provider attaches the contributor as a component:

```typescript
// In ForgeProvider.attach():
components.set(FORGE_GOVERNANCE, contributor);
// Key: "governance:contrib:forge"
```

The L1 extension discovers it with zero L2 knowledge:

```typescript
// In GovernanceExtension.guards():
const contributors = agent.query("governance:contrib:");
// Finds ALL contributors — forge, billing, custom, etc.
for (const [, contributor] of contributors) {
  for (const variable of contributor.variables()) {
    builder.register(variable);
  }
}
builder.seal();
```

---

## Configuration

### Via createKoi()

```typescript
const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: myAdapter,
  governance: {
    spawn: { maxDepth: 3, maxFanOut: 5 },
    iteration: { maxTurns: 50, maxTokens: 200_000, maxDurationMs: 600_000 },
    errorRate: { windowMs: 60_000, threshold: 0.5 },
    cost: { maxCostUsd: 2.0, costPerInputToken: 0.000003, costPerOutputToken: 0.000015 },
  },
});
```

All fields are optional — defaults are applied via deep merge.

### Defaults

```
spawn.maxDepth:          3
spawn.maxFanOut:         5
iteration.maxTurns:      25
iteration.maxTokens:     100,000
iteration.maxDurationMs: 300,000 (5 minutes)
errorRate.windowMs:      60,000 (1 minute)
errorRate.threshold:     0.5 (50% error rate)
cost.maxCostUsd:         0 (disabled)
cost.costPerInputToken:  0
cost.costPerOutputToken: 0
```

---

## Performance

| Hot-path operation | Cost |
|--------------------|------|
| `onBeforeTurn` (record + checkAll 7 vars) | ~1-2 µs |
| `wrapToolCall` (check spawn + record) | ~0.5-1 µs |
| `wrapModelCall` (record token_usage + cost) | ~0.3-0.5 µs |
| `snapshot()` (diagnostic, off hot-path) | ~2-5 µs |

Total overhead per turn: < 5 µs vs. model call latency of 500ms-10s.

Memory: 7 scalar counters + 1 pre-allocated 1000-slot ring buffer. Fully bounded.

---

## Source files

| File | Purpose |
|------|---------|
| `packages/core/src/governance.ts` | L0 types: GovernanceController, GovernanceVariable, GovernanceCheck, GOVERNANCE_VARIABLES |
| `packages/engine/src/governance-controller.ts` | `createGovernanceController()` + GovernanceControllerBuilder |
| `packages/engine/src/governance-extension.ts` | `createGovernanceExtension()` KernelExtension |
| `packages/engine/src/governance-provider.ts` | `createGovernanceProvider()` ComponentProvider |
| `packages/engine/src/governance-reconciler.ts` | `createGovernanceReconciler()` background drift detection |
| `packages/engine/src/rolling-window.ts` | Pre-allocated ring buffer for error rate |
| `packages/engine/src/types.ts` | `GovernanceConfig`, `DEFAULT_GOVERNANCE_CONFIG` |

### Tests

| File | Cases |
|------|-------|
| `packages/engine/src/governance-controller.test.ts` | 38 unit tests |
| `packages/engine/src/governance-extension.test.ts` | 9 unit tests |
| `packages/engine/src/governance-provider.test.ts` | 3 unit tests |
| `packages/engine/src/governance-reconciler.test.ts` | 7 unit tests |
| `packages/engine/src/rolling-window.test.ts` | 6 unit tests |
| `packages/engine/__tests__/governance-integration.test.ts` | 11 integration tests |
| `packages/engine/__tests__/governance-e2e.test.ts` | 9 E2E tests (real Anthropic API) |

---

## Relationship to other subsystems

```
                    ┌──────────────┐
                    │ AgentManifest│  createKoi({ governance: ... })
                    └──────┬───────┘
                           │
                ┌──────────┼──────────────┐
                ▼          ▼              ▼
       ┌────────────┐ ┌──────────┐ ┌──────────────┐
       │ Governance │ │ Default  │ │ L2           │
       │ Extension  │ │ Guard    │ │ Contributors │
       │            │ │ Extension│ │ (forge etc.) │
       │ discovers  │ │          │ │              │
       │ + seals    │ │ iteration│ │ attached via │
       │ + produces │ │ loop     │ │ prefix query │
       │ guard MW   │ │ spawn    │ │              │
       └─────┬──────┘ └────┬─────┘ └──────────────┘
             │              │
             ▼              ▼
       ┌─────────────────────────┐
       │   Middleware Chain       │
       │                         │
       │  governance-guard (p:0) │ ◄── turns, tokens, cost, errors
       │  iteration-guard  (p:0) │ ◄── legacy turn/token/duration
       │  loop-detector    (p:0) │ ◄── repeated pattern detection
       │  spawn-guard      (p:0) │ ◄── process tree limits
       │  ... L2 middleware ...  │
       └───────────┬─────────────┘
                   │
                   ▼
       ┌──────────────────────┐
       │   Engine Adapter      │
       │   (model + tool calls)│
       └──────────────────────┘
```

## Comparison with prior art

| Concept | Koi Governance | OpenClaw | NanoClaw |
|---------|---------------|----------|----------|
| Resource tracking | 7+ unified sensors | Per-tool budget | None (container isolation) |
| Cost awareness | Per-token USD tracking | Cost caps per model | No |
| Extensibility | L2 contributor pattern | Plugin hooks | No |
| Error rate | Rolling window | Fixed threshold | No |
| Snapshot/observability | `snapshot()` with utilization | Logs only | Container metrics |
| Enforcement | Guard middleware (pre-turn) | Pre-call interceptor | Container limits |
| Reconciliation | Background drift detection | None | None |
