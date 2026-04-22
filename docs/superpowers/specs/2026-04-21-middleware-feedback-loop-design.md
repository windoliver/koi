# Design: @koi/middleware-feedback-loop

**Date:** 2026-04-21
**Issue:** #1413
**Branch:** feat/middleware-feedback-retry
**Status:** Approved — ready for implementation

---

## Summary

Full v2 port of `middleware-feedback-loop` from v1 archive. Intercepts every model response and tool call. On model validation failure, injects structured error context back into the prompt and retries. Quality gates halt the pipeline without retry. For forged tools, tracks runtime health in a sliding-window ring buffer, quarantines tools that breach error thresholds, and demotes trust tiers on sustained failure.

---

## Scope Decision

**Full port (Option C)** — includes validators, gates, retry/repair, AND the forge tool health tracker (ring buffer, quarantine, demotion, fitness persistence). ~75% LOC reduction vs. v1 by dropping: circuit breaker on flush, lazy repair resolution, forge-repair module.

---

## Type Reconciliation

| Doc type | Real core type | Resolution |
|---|---|---|
| `TrustTier = "promoted" \| "verified" \| "sandbox"` | `TrustTier = "local" \| "community" \| "verified"` | Use core types. Demotion order: `"verified" → "community" → "local"` (floor) |
| `SnapshotStore` | Deprecated — use `SnapshotChainStore<BrickSnapshot>` | Use `SnapshotChainStore`. Quarantine/demotion records call `put(brickId, snapshot, [headNodeId])` |
| `DemotionCriteria` | Not in core | Define locally in `types.ts` — middleware-specific policy |

---

## Architecture

**Layer:** L2 — depends only on `@koi/core` (L0) and `@koi/errors`, `@koi/validation` (L0u).

### File Layout

| File | Responsibility | LOC est. |
|---|---|---|
| `types.ts` | `Validator`, `Gate`, `RepairStrategy`, `ValidationError`, `DemotionCriteria`, `TrustDemotionEvent`, `ToolHealthSnapshot`, `ForgeToolErrorFeedback` | ~120 |
| `config.ts` | `FeedbackLoopConfig`, `ForgeHealthConfig`, `RetryConfig`, defaults | ~80 |
| `validators.ts` | Run validator array → collect `ValidationError[]` | ~40 |
| `gate.ts` | Run gate array → throw `KoiRuntimeError` on fail | ~30 |
| `repair.ts` | Default repair strategy — inject errors back into messages as user turn | ~60 |
| `retry.ts` | Retry loop with category budgets (validation vs transport) | ~80 |
| `tool-health.ts` | Ring buffer, quarantine/demotion state machine, fitness flush | ~400 |
| `fitness-flush.ts` | `shouldFlush()` + `computeMergedFitness()` pure exported functions | ~80 |
| `feedback-loop.ts` | Middleware factory — wires all pieces, `priority: 450` | ~120 |
| `index.ts` | Public exports | ~30 |

**Total:** ~1,040 LOC

### Public API Surface

```typescript
// Primary factory
createFeedbackLoopMiddleware(config: FeedbackLoopConfig): KoiMiddleware

// Health tracker — also directly usable outside middleware
createToolHealthTracker(config: ToolHealthTrackerConfig): ToolHealthTracker

// Exported pure functions (for testing + external use)
shouldFlush(state: ToolFlushState, flushThreshold: number, errorRateDeltaThreshold: number): boolean
computeMergedFitness(deltas: FlushDeltas, existing: BrickFitnessMetrics | undefined): BrickFitnessMetrics
computeHealthAction(metrics, currentState, currentTrustTier, quarantineThreshold, quarantineWindowSize, demotionCriteria, lastPromotedAt, lastDemotedAt, now): HealthAction
```

---

## Model Call Flow

`wrapModelCall` implements this pipeline:

```
next(request)
  → catch error → classify as transport error
  → if transportBudget > 0: retry (up to maxTransportAttempts)
  → on success: runValidators(response) → collect ValidationErrors
  → if errors && validationBudget > 0:
      repairStrategy.buildRetryRequest(request, errors) → retry
  → if errors && budget exhausted: throw KoiRuntimeError
  → runGates(response) → gate fails: throw immediately (no retry)
```

**Retry budgets** (configured separately via `RetryConfig`):
- `validation.maxAttempts` — model output failed a validator (default: 3)
- `transport.maxAttempts` — network/API error (default: 2)

**Callbacks:**
- `onRetry(attempt, errors)` — fires before each retry
- `onGateFail(gate, errors)` — fires on gate halt

**Default repair strategy:** appends a `user` content block to the message list containing the structured validation errors. Fully replaceable via `repairStrategy` config.

---

## Tool Call Flow

`wrapToolCall` with optional forge health tracking:

```
toolValidators? → reject input before execution (throws ValidationError)
→ forgeHealth configured?
    → resolveBrickId(toolId) → undefined = skip health tracking, pass through
    → isQuarantined(brickId)? → return ForgeToolErrorFeedback (tool never executes)
→ clock() = start
→ next(request)
→ clock() = end, latencyMs = end - start
→ SUCCESS path:
    recordSuccess(brickId, latencyMs)
    shouldFlushTool(brickId)? → flushTool(brickId) [fire-and-forget, no await]
    runToolGates(response)
      → gate fail: recordFailure() → checkAndQuarantine() → checkAndDemote() → throw
→ FAILURE path:
    recordFailure(brickId, latencyMs, error.message)
    checkAndQuarantine(brickId) → if quarantined: forgeStore.update() + snapshotChainStore.put()
    checkAndDemote(brickId) → if demoted: forgeStore.update() + snapshotChainStore.put()
    re-throw original error
```

---

## Tool Health Tracker

### Ring Buffer

Per tracked brick: fixed-size circular buffer of size `max(quarantineWindow, demotionWindow)`. Each entry: `{ success: boolean, latencyMs: number }`.

- **Quarantine window** (default: 10) — fast kill for acutely broken tools
- **Demotion window** (default: 20) — more evidence required for trust tier change

### Quarantine State Machine

`computeHealthAction()` — pure function, exported for table-driven tests:

```
healthy → degraded → quarantined (terminal)
  ↑ error rate ≥ 75% of quarantine threshold → degraded
  ↑ error rate ≥ quarantine threshold (default 50%) → quarantined
```

Quarantine: `forgeStore.update(brickId, { lifecycle: "quarantined" })` + snapshot record.

### Trust Tier Demotion

Orthogonal axis to quarantine. Demotion order using real core `TrustTier`:

```
"verified" → "community" → "local" (floor — no further demotion)
```

Fires when ALL of:
- Error rate ≥ `demotionCriteria.errorRateThreshold` (default: 0.3) over last `windowSize` (default: 20)
- Sample size ≥ `minSampleSize` (default: 10)
- Time since last promotion ≥ `gracePeriodMs` (default: 1h)
- Time since last demotion ≥ `demotionCooldownMs` (default: 30min)

Demotion: `forgeStore.update(brickId, { trustTier: newTier })` + snapshot record.

### Fitness Persistence

Cumulative counters (separate from ring buffer) track total session success/failure + latency reservoir. Flush triggers:
- Invocations per tool ≥ `flushThreshold` (default: 10), OR
- `|errorRate - lastFlushedErrorRate|` > `errorRateDeltaThreshold` (default: 0.05)

Flush: fire-and-forget (does not block tool response). `onSessionEnd` → `dispose()` drains all remaining dirty tools.

Concurrent flush guard: `flushing` boolean per tool prevents duplicate in-flight writes.

---

## Testing Plan

Test files colocated with source. Coverage ≥ 80%.

| Test file | Key cases |
|---|---|
| `validators.test.ts` | all pass, one fails, multiple fail, empty array no-op |
| `gate.test.ts` | passes, fails + throws, multiple gates evaluated in order |
| `repair.test.ts` | injects errors as user turn, preserves existing messages, immutable |
| `retry.test.ts` | validation budget exhausted throws, transport budget exhausted throws, `onRetry` fires each attempt, budget per category independent |
| `fitness-flush.test.ts` | `shouldFlush` table-driven (dirty/flushing/threshold combos), `computeMergedFitness` adds counts + merges latency samples + takes max lastUsedAt |
| `tool-health.test.ts` | quarantine threshold fires, grace period blocks demotion, cooldown blocks re-demotion, sandbox floor (`"local"`) prevents further demotion, ring buffer wraps correctly, fitness flush threshold, dispose drains dirty tools |
| `feedback-loop.test.ts` | zero-config no-op, model validation + retry wired, gate halts pipeline, forgeHealth wired end-to-end, session lifecycle (start/end) |

Mock strategy: `ForgeStore` and `SnapshotChainStore` as plain in-memory objects. Injectable `clock: () => number` for deterministic timing tests.

---

## Layer Compliance

- [x] Imports only `@koi/core` (L0) and `@koi/errors`, `@koi/validation` (L0u)
- [x] Zero imports from `@koi/engine` (L1) or any L2 peer
- [x] All interface properties `readonly`
- [x] No vendor types
- [x] `ForgeStore` and `SnapshotChainStore` are L0 interfaces — implementations injected

Dev dependencies (tests only): `@koi/engine`, `@koi/test-utils`

---

## What Is NOT Ported from v1

| Dropped | Reason |
|---|---|
| Circuit breaker on fitness flush | Assume ForgeStore is reliable; fail-fast if not |
| Lazy repair strategy resolution | Require repair strategy at config time |
| `forge-repair.ts` module | Forge-specific repair was over-specialized; covered by default repair |
| Per-class retry budget overrides | Single `validation.maxAttempts` + `transport.maxAttempts` is sufficient |
| Backwards-compat multi-session fallback | v2 requires `sessionId` — no optional fallback |
