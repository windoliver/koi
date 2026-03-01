# @koi/middleware-feedback-loop — Model Validation, Retry, Quality Gates, and Forge Tool Health

Intercepts every model response and tool call. On model validation failure, injects structured error context back into the prompt and retries. Quality gates halt the pipeline without retry. For forged tools, tracks runtime health in a sliding-window ring buffer, quarantines tools that breach error thresholds, and demotes trust tiers on sustained failure. Zero LLM involvement for health tracking — pure arithmetic and state machine evaluation.

---

## Why It Exists

Agents call LLMs and tools in an open loop. Without validation and feedback, failures cascade:

1. **No output quality enforcement** — the LLM may return malformed JSON, hallucinated tool names, or unsafe content. Without validation + retry, consumers must handle every edge case
2. **No structured retry** — when a model response fails validation, the agent has no mechanism to inject the error context back into the next request. Manual retry logic is duplicated across every adapter
3. **No quality gates** — some failures are non-retryable (safety violations, policy breaches). Without gates that halt the pipeline, these errors get retried wastefully
4. **No tool health visibility** — forged tools (created at runtime by agents) may degrade or break. Without health tracking, broken tools stay "promoted" and keep being selected by the resolver
5. **No gradual degradation** — before Issue #259, a failing tool had two fates: permanent quarantine (death) or manual intervention. No intermediate "demotion" step to give tools a chance to recover

This middleware is the feedback loop between model output → validation → error injection → retry, and between tool execution → health tracking → quarantine/demotion.

---

## Architecture

`@koi/middleware-feedback-loop` is an **L2 feature package** — depends only on L0 (`@koi/core`) and L0u (`@koi/errors`, `@koi/validation`).

```
┌──────────────────────────────────────────────────────────┐
│  @koi/middleware-feedback-loop  (L2)                      │
│                                                          │
│  types.ts             ← domain types (Validator, etc.)   │
│  config.ts            ← config interface + Zod validation│
│  feedback-loop.ts     ← middleware factory (entry point) │
│  retry.ts             ← retry loop w/ category budgets   │
│  repair.ts            ← error feedback injection         │
│  gate.ts              ← quality gate evaluation          │
│  validators.ts        ← validator orchestration          │
│  tool-health.ts       ← health tracker + demotion engine │
│  fitness-flush.ts     ← fitness persistence bridge       │
│  forge-repair.ts      ← forge-specific repair strategy   │
│  index.ts             ← public API surface               │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  Dependencies                                            │
│                                                          │
│  @koi/core       (L0)   KoiMiddleware, ModelRequest,     │
│                          ModelResponse, ToolRequest,      │
│                          ToolResponse, TurnContext,       │
│                          ForgeStore, SnapshotStore,       │
│                          DemotionCriteria, TrustTier,     │
│                          BrickFitnessMetrics              │
│  @koi/errors     (L0u)  KoiRuntimeError, extractMessage  │
│  @koi/validation (L0u)  LatencySampler, mergeSamplers    │
│  zod             (ext)  Config validation schemas         │
└──────────────────────────────────────────────────────────┘
```

---

## How It Works

### Two Interception Points

The middleware hooks into both model calls and tool calls:

```
wrapModelCall  →  call LLM  →  validate  →  fail? inject error + retry
                                          →  pass? run gates → return
wrapToolCall   →  health check (quarantine?)  →  validate input
               →  call tool  →  record health  →  run gates → return
```

### Model Call Flow

```
  LLM Request
       │
       ▼
┌──────────────┐     ┌───────────────┐
│  retryLoop   │────►│  next(request) │  call LLM
│  (budgeted)  │     └───────┬───────┘
└──────┬───────┘             │
       │                     ▼
       │              ┌───────────────┐
       │              │  validators   │  check output
       │              └───────┬───────┘
       │                     │
       │              PASS   │   FAIL
       │               │     │     │
       │               │     │     ▼
       │               │     │  ┌──────────────┐
       │               │     │  │ repair()     │  inject errors
       │               │     │  │ → retry      │  into next request
       │               │     │  └──────────────┘
       │               │     │
       │               ▼     │
       │         ┌───────────┐
       │         │  gates    │  non-retryable check
       │         └─────┬─────┘
       │               │
       │         PASS   │   FAIL
       │           │         │
       │           ▼         ▼
       │      return      throw KoiRuntimeError
       │      response    (pipeline halted)
       │
       └─── retry budget exhausted → throw
```

### Tool Call Flow (with Forge Health Tracking)

```
  Tool Request (toolId, input)
       │
       ▼
┌──────────────────┐
│ Is forged tool?  │──── NO ──► skip health tracking
│ resolveBrickId() │
└────────┬─────────┘
         │ YES
         ▼
┌──────────────────┐
│ Is quarantined?  │──── YES ─► return ForgeToolErrorFeedback
│ isQuarantined()  │           (tool never executed)
└────────┬─────────┘
         │ NO
         ▼
┌──────────────────┐
│ Input validators │──── FAIL ─► throw validation error
└────────┬─────────┘
         │ PASS
         ▼
┌──────────────────┐
│ clock() = start  │    start latency timer
│ EXECUTE TOOL     │
│ next(request)    │
└────────┬─────────┘
        ╱ ╲
      ╱     ╲
  SUCCESS    FAILURE
     │          │
     ▼          ▼
┌─────────┐ ┌────────────────────────────────────┐
│ Output  │ │ recordFailure(toolId, latency, err) │
│ gates   │ │ checkAndQuarantine()                │
└────┬────┘ │ checkAndDemote()   ← NEW (Issue #259)│
     │      │ re-throw error                      │
  PASS│FAIL └────────────────────────────────────┘
     │  │
     │  └─► recordFailure → same quarantine/demotion check
     ▼
┌──────────────────┐
│ recordSuccess()  │
│ return to LLM    │
└──────────────────┘
```

---

## Forge Tool Health Tracking

### Ring Buffer

Each forged tool gets a fixed-size ring buffer that records success/failure and latency for every invocation. Two sliding windows query the same buffer:

```
Ring buffer (size = max(quarantine window, demotion window)):

  ┌───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┐
  │ ✓ │ ✓ │ ✓ │ ✗ │ ✓ │ ✗ │ ✗ │ ✓ │ ✗ │ ✓ │ ✓ │ ✗ │ ✗ │ ✗ │ ✓ │ ✗ │ ✓ │ ✗ │ ✗ │ ✗ │
  └───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┘
                                                            ◄── quarantine window (10) ──►
  ◄──────────────────────── demotion window (20) ──────────────────────────────────────►
```

- **Quarantine window** (default: 10) — fast kill for acutely broken tools
- **Demotion window** (default: 20) — slower, more evidence for trust demotion

### State Machine

```
                computeHealthAction() — pure function
  ┌─────────────────────────────────────────────────────────┐
  │                                                         │
  │  healthy ──────────► degraded ──────────► quarantined   │
  │     │                   │                    │          │
  │     │  error rate       │  error rate        │          │
  │     │  ≥ 75% of        │  ≥ quarantine      │ terminal │
  │     │  quarantine       │  threshold         │ state    │
  │     │  threshold        │                    │          │
  │     │                   │                    │          │
  │     │  action: none     │  action: demote    │ action:  │
  │     │                   │  or quarantine     │ none     │
  │     │                   │                    │          │
  └─────┴───────────────────┴────────────────────┘          │
                                                            │
                Trust Tier Demotion (orthogonal axis)        │
  ┌─────────────────────────────────────────────────────────┘
  │
  │  promoted ──────► verified ──────► sandbox (floor)
  │     │                │
  │     │  error rate    │  error rate
  │     │  ≥ 30%         │  ≥ 30%
  │     │  + min samples │  + min samples
  │     │  + grace ok    │  + grace ok
  │     │  + cooldown ok │  + cooldown ok
  │     │                │
  │     ▼                ▼
  │  one step down    one step down
  │                      │
  │                      ▼
  │                   sandbox
  │                   (no further
  │                    demotion)
  └─────────────────────────────────────────────────────────
```

### Fitness Persistence Bridge (Issue #251)

Runtime health data (success/failure counts, latency) is tracked in-memory by the `ToolHealthTracker`. Without persistence, all health data is lost on process restart, and the scoring infrastructure (`computeBrickFitness`, `sortBricks`, `evaluateTrustDecay`) operates on empty `BrickFitnessMetrics`.

The fitness persistence bridge closes this loop by flushing cumulative session data to `ForgeStore` via threshold-based triggers.

```
  Tool Invocation
       │
       ▼
┌────────────────────┐
│ recordSuccess() /  │    ① Increment cumulative counters
│ recordFailure()    │    ② Push latency to reservoir buffer
│                    │    ③ Set dirty = true
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ shouldFlushTool()  │    Threshold check:
│                    │    • invocations ≥ K (default 10), OR
│                    │    • |errorRate - lastFlushedRate| > δ (default 5%)
└────────┬───────────┘
         │ YES
         ▼
┌────────────────────┐
│ flushTool()        │    ① Capture deltas (success, failure, latency)
│                    │    ② Load existing BrickFitnessMetrics from ForgeStore
│                    │    ③ Merge: computeMergedFitness(deltas, existing)
│                    │    ④ Update ForgeStore with merged fitness + usageCount
│                    │    ⑤ Reset flush state (invocations, dirty, lastFlushed*)
└────────────────────┘
         │
         ▼
  ForgeStore now has real fitness data
  → computeBrickFitness, sortBricks, evaluateTrustDecay work correctly
```

**Cumulative counters vs. ring buffer**: The ring buffer tracks recent invocations for quarantine/demotion decisions. The cumulative counters track total successes/failures within the session for fitness persistence. Both are updated on every `record()` call.

**Reservoir sampling**: The latency buffer has a cap (default 200). When full, new samples replace existing ones with decreasing probability (`1/totalCount`), maintaining a statistically representative sample without unbounded memory growth.

**Concurrent flush guard**: Each tool has a `flushing` boolean. If a flush is already in-flight, `shouldFlushTool()` returns false. This prevents duplicate writes without requiring locks.

**Graceful NOT_FOUND handling**: If the brick was deleted between recording and flushing, the flush clears the dirty flag and calls `onFlushError` instead of retrying indefinitely.

**Session drain**: When the middleware's `onSessionEnd` fires, `dispose()` flushes all remaining dirty tools, ensuring no data is lost at shutdown.

### Demotion vs. Quarantine

These are **two independent axes**. Demotion lowers privileges; quarantine kills the tool.

| | Demotion | Quarantine |
|---|---|---|
| **What changes** | Trust tier (promoted → verified → sandbox) | Lifecycle state (active → quarantined) |
| **Reversible?** | Yes — agent can re-promote | No — tool must be re-forged |
| **Threshold** | 30% error rate (configurable) | 50% error rate (configurable) |
| **Window** | 20 invocations (more evidence) | 10 invocations (fast kill) |
| **Safety rails** | Grace period + cooldown | None (immediate) |
| **Effect** | Tool still callable, reduced resolver priority | Tool disabled, returns structured error |

### Safety Mechanisms

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   GRACE PERIOD   │    │    COOLDOWN      │    │  SANDBOX FLOOR   │
│                  │    │                  │    │                  │
│  Don't demote    │    │  Don't demote    │    │  sandbox is the  │
│  within 1h of    │    │  again within    │    │  lowest tier.    │
│  a promotion.    │    │  30min of last   │    │  Can't demote    │
│                  │    │  demotion.       │    │  below it.       │
│  Prevents        │    │                  │    │                  │
│  flapping on     │    │  Prevents rapid  │    │  Only quarantine │
│  transient       │    │  cascade to      │    │  can stop the    │
│  errors.         │    │  sandbox.        │    │  tool now.       │
└──────────────────┘    └──────────────────┘    └──────────────────┘

┌──────────────────┐    ┌──────────────────┐
│  MIN SAMPLE SIZE │    │  AGENT vs SYSTEM │
│                  │    │                  │
│  Need ≥10 data   │    │  Agents can ONLY │
│  points before   │    │  promote (up).   │
│  demotion fires. │    │                  │
│                  │    │  System can      │
│  No knee-jerk    │    │  demote (down).  │
│  reactions on    │    │                  │
│  small samples.  │    │  Shared via      │
│                  │    │  validateTrust   │
│                  │    │  Transition()    │
└──────────────────┘    └──────────────────┘
```

---

## API Reference

### Factory: `createFeedbackLoopMiddleware(config)`

Returns a `KoiMiddleware` with priority **450**.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `validators` | `readonly Validator[]` | `[]` | Model output validators (retry on failure) |
| `gates` | `readonly Validator[]` | `[]` | Model output gates (halt on failure) |
| `toolValidators` | `readonly Validator[]` | `[]` | Tool input validators (reject before execution) |
| `toolGates` | `readonly Validator[]` | `[]` | Tool output gates (halt after execution) |
| `retry` | `RetryConfig` | `{}` | Category-aware retry budgets |
| `repairStrategy` | `RepairStrategy` | `defaultRepairStrategy` | Error feedback injection |
| `onRetry` | `(attempt, errors) => void` | — | Callback on each retry |
| `onGateFail` | `(gate, errors) => void` | — | Callback on gate failure |
| `forgeHealth` | `ForgeHealthConfig` | — | Forge tool health tracking (optional) |

### Factory: `createToolHealthTracker(config)`

Returns a `ToolHealthTracker` for direct use outside the middleware.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `resolveBrickId` | `(toolId) => string \| undefined` | **required** | Maps tool ID to brick ID |
| `forgeStore` | `ForgeStore` | **required** | Brick store for lifecycle updates |
| `snapshotStore` | `SnapshotStore` | **required** | Audit trail for quarantine/demotion events |
| `quarantineThreshold` | `number` | `0.5` | Error rate (0-1) to trigger quarantine |
| `windowSize` | `number` | `10` | Quarantine sliding window size |
| `maxRecentFailures` | `number` | `5` | Recent failure records retained per tool |
| `onQuarantine` | `(brickId) => void` | — | Callback when tool is quarantined |
| `demotionCriteria` | `Partial<DemotionCriteria>` | `DEFAULT_DEMOTION_CRITERIA` | Demotion thresholds |
| `onDemotion` | `(event) => void` | — | Callback when trust tier is demoted |
| `clock` | `() => number` | `Date.now` | Injectable clock for testing |
| `flushThreshold` | `number` | `10` | Flush after this many invocations per tool |
| `errorRateDeltaThreshold` | `number` | `0.05` | Flush when error rate changes by more than this |
| `onFlushError` | `(toolId, error) => void` | — | Callback on flush failure |
| `onDemotionError` | `(toolId, error) => void` | — | Callback on demotion check failure |

### `ToolHealthTracker` Interface

```typescript
interface ToolHealthTracker {
  readonly recordSuccess: (toolId: string, latencyMs: number) => void;
  readonly recordFailure: (toolId: string, latencyMs: number, error: string) => void;
  readonly getSnapshot: (toolId: string) => ToolHealthSnapshot | undefined;
  readonly isQuarantined: (toolId: string) => boolean;
  readonly checkAndQuarantine: (toolId: string) => Promise<boolean>;
  readonly checkAndDemote: (toolId: string) => Promise<boolean>;
  readonly getAllSnapshots: () => readonly ToolHealthSnapshot[];
  readonly shouldFlushTool: (toolId: string) => boolean;
  readonly flushTool: (toolId: string) => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}
```

### Pure Function: `shouldFlush()`

Determines whether a tool's fitness data should be flushed to ForgeStore.

```typescript
function shouldFlush(
  state: ToolFlushState,
  flushThreshold: number,
  errorRateDeltaThreshold: number,
): boolean
// Returns true when dirty && !flushing && (invocations >= threshold OR |errorRateDelta| > threshold)
```

### Pure Function: `computeMergedFitness()`

Merges session deltas with existing persisted fitness metrics.

```typescript
function computeMergedFitness(
  deltas: FlushDeltas,
  existing: BrickFitnessMetrics | undefined,
): BrickFitnessMetrics
// Adds deltas to existing counts, merges latency samplers, takes max(lastUsedAt)
```

### Pure Function: `computeHealthAction()`

Exported for table-driven testing. No I/O, no side effects.

```typescript
function computeHealthAction(
  metrics: ToolHealthMetrics,
  currentState: ToolHealthState,
  currentTrustTier: TrustTier,
  quarantineThreshold: number,
  quarantineWindowSize: number,
  demotionCriteria: DemotionCriteria,
  lastPromotedAt: number,
  lastDemotedAt: number,
  now: number,
): HealthAction
// Returns: { state: "healthy" | "degraded" | "quarantined", action: "none" | "demote" | "quarantine" }
```

### Types

```typescript
interface DemotionCriteria {
  readonly errorRateThreshold: number;   // 0.3 = 30%
  readonly windowSize: number;           // 20
  readonly minSampleSize: number;        // 10
  readonly gracePeriodMs: number;        // 3_600_000 (1 hour)
  readonly demotionCooldownMs: number;   // 1_800_000 (30 min)
}

interface TrustDemotionEvent {
  readonly brickId: string;
  readonly from: string;                 // "promoted" | "verified"
  readonly to: string;                   // "verified" | "sandbox"
  readonly reason: TrustDemotionReason;  // "error_rate" | ...
  readonly evidence: {
    readonly errorRate: number;
    readonly sampleSize: number;
    readonly periodMs: number;
  };
}
```

---

## Examples

### 1. Basic model validation with retry

```typescript
import { createFeedbackLoopMiddleware } from "@koi/middleware-feedback-loop";

const mw = createFeedbackLoopMiddleware({
  validators: [
    {
      name: "json-output",
      validate: (output) => {
        try { JSON.parse(String(output)); return { valid: true }; }
        catch { return { valid: false, errors: [{ validator: "json-output", message: "Not valid JSON" }] }; }
      },
    },
  ],
  retry: { validation: { maxAttempts: 3 } },
});
```

### 2. Forge tool health tracking

```typescript
import { createFeedbackLoopMiddleware } from "@koi/middleware-feedback-loop";
import { createInMemoryForgeStore } from "@koi/forge";

const forgeStore = createInMemoryForgeStore();
const snapshotStore = createMySnapshotStore();

const mw = createFeedbackLoopMiddleware({
  forgeHealth: {
    resolveBrickId: (toolId) =>
      toolId.startsWith("forged-") ? `brick-${toolId}` : undefined,
    forgeStore,
    snapshotStore,
    quarantineThreshold: 0.5,
    windowSize: 10,
    onQuarantine: (brickId) => {
      console.log(`Tool ${brickId} quarantined — agent must re-forge`);
    },
  },
});
```

### 3. Health tracking with demotion (Issue #259)

```typescript
const mw = createFeedbackLoopMiddleware({
  forgeHealth: {
    resolveBrickId: (toolId) => forgeRegistry.resolve(toolId),
    forgeStore,
    snapshotStore,
    quarantineThreshold: 0.5,
    windowSize: 10,
    demotionCriteria: {
      errorRateThreshold: 0.3,    // demote at 30% error rate
      windowSize: 20,             // over last 20 invocations
      minSampleSize: 10,          // need at least 10 data points
      gracePeriodMs: 3_600_000,   // 1h grace after promotion
      demotionCooldownMs: 1_800_000, // 30min between demotions
    },
    onDemotion: (event) => {
      console.log(`Trust demoted: ${event.from} → ${event.to}`);
      console.log(`Reason: ${event.reason}, error rate: ${event.evidence.errorRate}`);
    },
    onQuarantine: (brickId) => {
      forgeProvider.invalidate(brickId);
    },
  },
});
```

### 4. Full stack: createKoi + middleware + health tracking

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createFeedbackLoopMiddleware } from "@koi/middleware-feedback-loop";

const feedbackMiddleware = createFeedbackLoopMiddleware({
  validators: [myJsonValidator],
  gates: [mySafetyGate],
  forgeHealth: {
    resolveBrickId,
    forgeStore,
    snapshotStore,
    onDemotion: handleDemotion,
    onQuarantine: handleQuarantine,
  },
});

const runtime = await createKoi({
  manifest: agentManifest,
  adapter: createPiAdapter({ model: "anthropic:claude-haiku-4-5-20251001" }),
  middleware: [feedbackMiddleware],
  providers: [toolProvider],
});

for await (const event of runtime.run({ kind: "text", text: userMessage })) {
  // Tool health tracking happens transparently in the middleware
  handleEvent(event);
}
```

### 5. Deterministic testing with injected clock

```typescript
import { createToolHealthTracker } from "@koi/middleware-feedback-loop";

const tracker = createToolHealthTracker({
  resolveBrickId: (id) => (id === "my-tool" ? "brick-1" : undefined),
  forgeStore: mockForgeStore,
  snapshotStore: mockSnapshotStore,
  clock: () => 100_000_000, // fixed time — deterministic
  demotionCriteria: {
    errorRateThreshold: 0.3,
    windowSize: 5,
    minSampleSize: 3,
    gracePeriodMs: 1000,
    demotionCooldownMs: 1000,
  },
});

// Record failures
tracker.recordFailure("my-tool", 10, "timeout");
tracker.recordFailure("my-tool", 10, "connection refused");
tracker.recordFailure("my-tool", 10, "500");

// Check demotion
const demoted = await tracker.checkAndDemote("my-tool");
expect(demoted).toBe(true);
```

### 6. Fitness persistence with flush callbacks

```typescript
const mw = createFeedbackLoopMiddleware({
  forgeHealth: {
    resolveBrickId: (toolId) => forgeRegistry.resolve(toolId),
    forgeStore,
    snapshotStore,
    // Flush after every 20 invocations per tool
    flushThreshold: 20,
    // Or when error rate changes by more than 10%
    errorRateDeltaThreshold: 0.1,
    onFlushError: (toolId, error) => {
      logger.warn("Fitness flush failed", { toolId, error });
    },
    onDemotionError: (toolId, error) => {
      logger.warn("Demotion check failed", { toolId, error });
    },
  },
});

// Middleware automatically flushes fitness data to ForgeStore on threshold.
// On session end (onSessionEnd), dispose() drains all remaining dirty tools.
```

---

## Performance

### Hot Path (tool call, no health tracking)

When `forgeHealth` is not configured, `wrapToolCall` checks three conditions and falls through:

```
toolValidators.length === 0 && toolGates.length === 0 && !isForgedTool → next(request)
```

**O(1)** — single boolean comparison, zero allocations.

### Hot Path (forged tool, healthy)

```
resolveBrickId(toolId)     O(1) — single lookup
isQuarantined(toolId)      O(1) — Map.get + boolean check
next(request)              O(tool execution time)
recordSuccess(toolId)      O(1) — ring buffer write at cursor + cumulative counter increment
shouldFlushTool(toolId)    O(1) — compare counters + error rate delta
computeHealthAction()      O(window) — scan ring buffer entries
```

**O(window)** per call — with default window=20, this is effectively O(1). The fitness flush check (`shouldFlushTool`) adds one comparison on every call but only triggers I/O every K invocations (default 10).

### Memory

Per tracked tool:

- Ring buffer: `max(quarantine window, demotion window)` entries = 20 × 16 bytes = 320 bytes
- Latency buffer: up to 200 entries × 8 bytes = 1.6 KB (reservoir sampled)
- Cumulative counters + flush state: 10 fields = 80 bytes
- Recent failures: up to `maxRecentFailures` records = 5 × ~200 bytes = 1 KB
- Cached trust tier + timestamps: 3 fields = 24 bytes

Total per tool: ~3 KB. For 100 forged tools: ~300 KB.

### Store Operations

Store I/O (async) only happens on threshold triggers — not on every call:

- **Demotion/quarantine**: `forgeStore.load()` + `forgeStore.update()` + `snapshotStore.record()`
- **Fitness flush**: `forgeStore.load()` + `forgeStore.update()` — every K invocations (default 10) or on error rate shift > 5%. Fire-and-forget (does not block the tool call response).
- **Session drain**: `dispose()` flushes all dirty tools once at session end via `onSessionEnd`

---

## Layer Compliance

```
  L0  @koi/core ──────────────────── types only, zero runtime
       │
  L0u @koi/errors ─────────────────── KoiRuntimeError, extractMessage
  L0u @koi/validation ─────────────── LatencySampler, mergeSamplers, recordLatency
       │
  L2  @koi/middleware-feedback-loop ── THIS PACKAGE
```

Checklist:

- [x] Imports only from `@koi/core` (L0) and L0u (`@koi/errors`, `@koi/validation`)
- [x] Zero imports from `@koi/engine` (L1) or peer L2 packages
- [x] All interface properties are `readonly`
- [x] No vendor types (LangGraph, OpenAI, etc.)
- [x] `ForgeStore` and `SnapshotStore` are L0 interfaces — implementations are injected
- [x] Dev-only dependencies: `@koi/engine`, `@koi/engine-pi`, `@koi/forge`, `@koi/test-utils` (E2E tests only)
- [x] Exported `ToolFlushState` is fully `readonly` — mutable version is internal only
