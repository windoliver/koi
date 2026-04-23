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
currentRequest = request
feedbackMessageId = undefined
attempt = 0

LOOP:
  try:
    response = await next(currentRequest)
  catch error:
    if transportBudget > 0:
      transportBudget--; attempt++
      onRetry(attempt, [error])
      CONTINUE LOOP  ← retry from currentRequest unchanged
    throw error

  errors = runValidators(response)
  if errors.length === 0:
    runGates(response) → gate fails: onGateFail() + throw (no retry)
    return response  ← success

  if validationBudget === 0: throw KoiRuntimeError (budget exhausted)
  validationBudget--; attempt++
  onRetry(attempt, errors)

  { request: currentRequest, feedbackMessageId } =
    repairStrategy.buildRetryRequest(
      currentRequest,       ← LAST EFFECTIVE request (preserves per-attempt middleware state)
      errors,
      { attempt, feedbackMessageId },
    )
  CONTINUE LOOP
```

**Retry budgets** (configured separately via `RetryConfig`):
- `validation.maxAttempts` — model output failed a validator (default: 3)
- `transport.maxAttempts` — network/API error (default: 2)

**Callbacks:**
- `onRetry(attempt, errors)` — fires before each retry
- `onGateFail(gate, errors)` — fires on gate halt

**Default repair strategy:** injects validation errors using a single replaceable feedback slot tracked via a **stable opaque ID** embedded in the message itself:

```typescript
interface RetryContext {
  readonly attempt: number;
  /** Opaque ID of the feedback message from the previous attempt, undefined on first retry. */
  readonly feedbackMessageId: string | undefined;
}

interface RepairStrategy {
  /** `originalRequest` is the request as received at `wrapModelCall` entry — never mutated. */
  readonly buildRetryRequest: (
    originalRequest: ModelRequest,
    errors: readonly ValidationError[],
    ctx: RetryContext,
  ) => { readonly request: ModelRequest; readonly feedbackMessageId: string };
}
```

The default strategy uses an **immutable base + single synthesized feedback slot** approach:

- The retry loop passes `currentRequest` (the last request actually sent to the model) into `buildRetryRequest`, preserving any per-attempt state added by upstream middleware (auth tokens, timestamps, system prompt refreshes).
- The default strategy appends or replaces exactly one feedback message at the tail of `currentRequest.messages`. Replacement is identified by `feedbackMessageId` — an opaque string that encodes the index into the messages array of the prior feedback slot. On first retry `feedbackMessageId` is `undefined` → append. On subsequent retries → replace at recorded index. If the index is out-of-range (another layer removed or reordered messages), fall back to append.
- The `feedbackMessageId` in the `RepairStrategy` return type threads this slot handle back into the retry loop for the next iteration.

**Test requirements for `retry.test.ts`:**
- Two consecutive validation failures → rebuilt request contains exactly one feedback message (latest), not two, and original user messages are unchanged.
- Mixed: validation retry followed by transport retry → feedback message from validation attempt is preserved in the transport-retried request.

**Test requirements for `retry.test.ts`:**
- Two consecutive validation failures → rebuilt request contains exactly one feedback message (latest), not two
- Original user messages unchanged across retries
- If feedback message was removed between retries, fresh one is appended (no panic/corrupt write)

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
→ EXECUTION SUCCESS path:
    runToolGates(response)              ← gates evaluated BEFORE any health accounting
      → gate fail:
          if gate.countAsHealthFailure === true:  ← explicit opt-in; default false
              recordFailure(brickId, latencyMs, "gate:${gate.name}")
              checkAndQuarantine() → if quarantined: forgeStore.update() + snapshotChainStore.put()
              checkAndDemote()    → if demoted:     forgeStore.update() + snapshotChainStore.put()
              shouldFlushTool(brickId)? → flushTool(brickId) [non-blocking]
          throw (gate failure always halts pipeline; health impact requires explicit opt-in — gates are
                 policy checks, not reliability signals; execution failures are the liveness signal)
      → gate pass:
          recordSuccess(brickId, latencyMs)    ← only recorded after all gates pass
          shouldFlushTool(brickId)?
            → flushTool(brickId) [non-blocking; errors handled — see Fitness Flush section]
→ EXECUTION FAILURE path:
    recordFailure(brickId, latencyMs, error.message)
    checkAndQuarantine(brickId) → if quarantined: forgeStore.update() + snapshotChainStore.put()
    checkAndDemote(brickId) → if demoted: forgeStore.update() + snapshotChainStore.put()
    shouldFlushTool(brickId)?                  ← evaluated on FAILURE too, not just success
      → flushTool(brickId) [non-blocking]
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

**Error isolation rule (applies to all health transitions):** Persistence errors from `forgeStore.update()` and `snapshotChainStore.put()` are ALWAYS caught and routed to `onHealthTransitionError`. They are NEVER re-thrown and NEVER replace the original tool execution error or gate rejection. The original error from `next(request)` or gate evaluation is always the primary exception thrown from `wrapToolCall`. Persistence bookkeeping is best-effort and must not corrupt caller-visible error semantics.

**Local session quarantine fallback:** If `forgeStore.update({ lifecycle: "quarantined" })` fails, the tool is immediately quarantined in the in-process session state (an in-memory `Set<BrickId>` checked by `isQuarantined()` before the store lookup). Future calls in this session return `ForgeToolErrorFeedback` without executing the tool or hitting the store again. `onHealthTransitionError` is still called to surface the persistence failure. On session end, any locally-quarantined but unwritten quarantines are noted via `onHealthTransitionError` — they are not retried since the session is ending. This maintains the safety invariant (broken tool stops executing) even during store outages.

Quarantine: Two-step write with defined ordering and failure semantics:
1. `forgeStore.update(brickId, { lifecycle: "quarantined" })` — ForgeStore write first (authoritative state). If this fails, abort — no snapshot written; tool remains in current state; `onQuarantine` is not called; error forwarded to `onHealthTransitionError({ transition: "quarantine", phase: "forgeStore", brickId, error })`.
2. `snapshotChainStore.put(brickId, snapshot, [headNodeId])` — Snapshot written second (audit trail). If this fails after ForgeStore succeeded, emit via `onHealthTransitionError({ transition: "quarantine", phase: "snapshot", brickId, error })` but do not rollback the ForgeStore update. ForgeStore is the source of truth; the snapshot is audit-only and missing one snapshot is recoverable.

Quarantine is idempotent: if `forgeStore.update()` returns CONFLICT (another writer already quarantined the brick), treat as success and skip the snapshot write.

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

Demotion: Same two-step ordering as quarantine — `forgeStore.update({ trustTier: newTier })` first, then `snapshotChainStore.put()`. Same failure semantics: ForgeStore failure aborts and emits `onHealthTransitionError({ transition: "demotion", phase: "forgeStore", ... })`; snapshot failure emits `onHealthTransitionError({ transition: "demotion", phase: "snapshot", ... })` but does not rollback. Idempotent: if the brick's trust tier already equals `newTier`, skip the snapshot write.

### Fitness Persistence

Cumulative counters (separate from ring buffer) track total session success/failure + latency reservoir. Flush triggers:
- Invocations per tool ≥ `flushThreshold` (default: 10), OR
- `|errorRate - lastFlushedErrorRate|` > `errorRateDeltaThreshold` (default: 0.05)

Flush: non-blocking (does not block tool response). The flush `Promise` is caught internally — errors are passed to `onFlushError(toolId, error)` callback, dirty state is preserved on failure so the next threshold trigger retries, and repeated failures increment a per-tool `consecutiveFlushFailures` counter. After `maxConsecutiveFlushFailures` (default: 5) consecutive failures, the tool's flush is suspended and `onFlushError` is called with a sentinel error describing suspension. This is a bounded circuit-breaker without blocking the hot path.

Concurrent flush guard: `flushing` boolean per tool prevents duplicate in-flight writes.

**Flush suspension and auto-recovery:** After `maxConsecutiveFlushFailures` (default: 5) consecutive failures, a tool's flush is suspended. Suspended state is surfaced via `ToolHealthSnapshot.flushSuspended: boolean` so operators can detect it. Auto-recovery: before each threshold-triggered flush attempt, if the tool is suspended and `now - lastFlushFailureAt >= flushSuspensionCooldownMs` (default: 60_000ms), suspension is cleared and the flush is retried. This bounds stale fitness data to at most one cooldown interval after store recovery, without requiring a restart.

**Shutdown (`dispose()`):** Bypasses suspension — dirty tools are flushed even if suspended. Each flush is awaited sequentially with a per-tool timeout bound (`flushTimeoutMs`, default: 2000ms) to prevent unbounded teardown latency.

`dispose()` **never throws**. If a flush fails, `onFlushError(toolId, error)` is called for observability, then shutdown continues to the next tool. Callers that need to know whether all data was persisted should use the `onFlushError` callback; `dispose()` itself is best-effort at shutdown.

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
| `tool-health.test.ts` | quarantine threshold fires, grace period blocks demotion, cooldown blocks re-demotion, sandbox floor (`"local"`) prevents further demotion, ring buffer wraps correctly, fitness flush threshold, dispose drains dirty tools, **gate-triggered failure persists quarantine/demotion to forgeStore + snapshotChainStore identically to execution failure** |
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
| Blocking flush circuit breaker | v1 had a global 3-strike breaker that paused ALL tools. v2 uses per-tool `consecutiveFlushFailures` counter with suspension, preserving dirty state for retry |
| Lazy repair strategy resolution | Require repair strategy at config time |
| `forge-repair.ts` module | Forge-specific repair was over-specialized; covered by default repair |
| Per-class retry budget overrides | Single `validation.maxAttempts` + `transport.maxAttempts` is sufficient |
| Backwards-compat multi-session fallback | v2 requires `sessionId` — no optional fallback |
