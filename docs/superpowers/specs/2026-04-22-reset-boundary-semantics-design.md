# Reset Boundary Semantics — Design Spec

**Issue:** #1939  
**Branch:** `fix/1939-reset-boundary-semantics`  
**Date:** 2026-04-22  

---

## Problem

`@koi/engine` has two inline reset sequences that must stay in sync but diverge:

- **Path 1** (non-cooperating adapter): `koi.ts:810–845` — resets guards immediately, records `iteration_reset` governance event, skips if a legacy guard is detected
- **Path 2** (cooperating adapter): `koi.ts:1050–1074` — defers resets to `applyRecomposition()`, records `iteration_reset` after, same legacy-guard skip logic duplicated

The term "iteration" is a Koi v2-only invention with no precedent in the Claude Code SDK (`maxTurns`, `turn_start`, `turn_end`) or Koi v1 (`TurnContext`, `reset()`). This drift in terminology makes the boundary semantics hard to reason about and caused the stale-duration timeout regression in #1917.

Additionally, reset events carry no provenance — when a reset fires, trace output cannot explain which boundary triggered it, from where, or why.

---

## Vocabulary

| Boundary | When | Governance event |
|----------|------|-----------------|
| `turn_end` | One model API round-trip completes | None — turn counters are per-run, not per-turn |
| `run_start` | `runtime.run()` is called by the host | `run_reset` |
| `session_cycle` | `runtime.cycleSession()` is called by the host | `session_reset` |

This table is the canonical reset contract. All guard resets and governance counter resets must align to these boundaries. No other reset sites are permitted.

---

## Design

### Section 1: L0 Changes (`@koi/core`)

**File:** `packages/kernel/core/src/governance.ts`

#### 1a. Rename `iteration_reset` → `run_reset` (hard rename, no deprecated alias)

The event fires at `run_start`, not at any "iteration" boundary. All `iteration_reset` consumers are internal to koi v2 — there are no external API consumers. The rename happens in one PR: producers and all consumers updated together, no dual-emit, no deprecated union member. Section 1c details scope.

New payload shape — flat provenance fields, consistent with Claude Code's `SessionStartHookInput.source` pattern and Koi v2's existing flat `reason` field on tool step metadata:

```typescript
| {
    readonly kind: "run_reset"
    readonly source: "host" | "guard" | "engine"
    readonly reason?: string
    readonly boundaryId: string  // deterministic: `${sessionId}:run:${runIndex}` — stable across replays
  }
```

`session_reset` keeps its kind name (already aligned with CC's `SessionEnd` hook), gains the same provenance fields:

```typescript
| {
    readonly kind: "session_reset"
    readonly source: "host" | "engine"
    readonly reason?: string
    readonly boundaryId: string  // deterministic: `${sessionId}:session:${sessionIndex}`
  }
```

**Deterministic `boundaryId`:** IDs are derived from existing engine state, not random UUIDs, so golden replay snapshots are stable across runs. Format: `${sessionId}:run:${runIndex}` for `run_reset`, `${sessionId}:session:${sessionIndex}` for `session_reset`.

**No `run_reset_partial` event.** Legacy guards (those without `resetForRun()`) are incompatible with `resetBudgetPerRun: true`. `createKoi()` throws at construction time if both are present. This is fail-closed: stale guard state can never silently persist into a new run.

#### 1b. Add `ResetBoundary` vocabulary constant

```typescript
/**
 * Canonical boundary → governance event mapping.
 * This contract applies when `resetBudgetPerRun: true` is set.
 * When `resetBudgetPerRun: false` (default), no `run_reset` event is emitted at run_start —
 * budgets accumulate across runs for the session lifetime.
 * Consumers: do not assume `run_reset` is always present. Check for `session_reset` instead
 * if you only need to know when a new session starts.
 */
export const RESET_BOUNDARIES = {
  turn_end:      "no governance event — turn counters are per-run, not per-turn",
  run_start:     "run_reset (only when resetBudgetPerRun: true)",
  session_cycle: "session_reset",
} as const satisfies Record<string, string>
```

This constant is the machine-readable form of the mapping table above. Agents and tools can import it; docs reference it. The `run_start` entry explicitly documents the conditional: consumers must not assume `run_reset` arrives on every run.

#### 1c. Remove `iteration_reset` — rename everywhere in this PR

All `iteration_reset` consumers are internal to koi v2 (governance-controller, golden-replay tests, in-memory-controller). There are no external consumers. Dual-writing two events for one boundary creates a double-counting hazard for any consumer that scans reset events generically — a problem that documentation and dedup contracts cannot reliably prevent.

**Approach: hard rename in one PR.**

- `iteration_reset` kind removed from `GovernanceEvent` union
- `governance-controller.ts` `record()` dispatch updated to handle `run_reset` and `run_reset_partial`
- Golden replay trajectory assertions updated to expect `run_reset`
- `resetIterationBudgetPerRun` renamed to `resetBudgetPerRun` in `CreateKoiOptions`
- No deprecated aliases, no dual-write, no consumer dedup burden

This is safe because the rename is contained entirely within the koi v2 monorepo.

---

### Section 2: L1 Changes (`@koi/engine`)

**File:** `packages/kernel/engine/src/koi.ts`

#### 2a. Extract `resetRunBoundary()` helper

A **module-local** function (not exported) that both adapter paths call. Pattern matches Claude Code's `clearSessionCaches()` — a single function that owns all paired resets, called inline from two sites.

```typescript
function resetRunBoundary(
  guards: ReadonlySet<KoiMiddleware>,
  governance: GovernanceController,
  runStartedAt: number,
  boundaryId: string,  // deterministic, passed by caller: `${sessionId}:run:${runIndex}`
): void {
  for (const mw of guards) {
    if (isIterationGuardHandle(mw)) {
      // Branded iteration guard — reset it.
      mw.resetForRun(runStartedAt)
    } else if (hasIterationGuardBrand(mw)) {
      // Has the brand but no resetForRun() — broken contract. Fail closed.
      throw new Error(
        `Middleware carries ITERATION_GUARD_BRAND but does not implement resetForRun(). ` +
        `All branded iteration guards must implement IterationGuardHandle. ` +
        `Guard: ${mw.name ?? "(unnamed)"}`
      )
    }
    // Unbranded middleware: not declared as an iteration guard. Not our concern.
  }
  governance.record({ kind: "run_reset", source: "engine", boundaryId })
}
```

**Capability contract (explicit):** `ITERATION_GUARD_BRAND` is the declaration that a middleware owns run-scoped mutable state and participates in run-boundary resets. Any middleware that carries the brand MUST implement `resetForRun()` — enforced at runtime by the helper. Middleware that does NOT carry the brand is not an iteration guard; the reset loop does not touch it and makes no assumptions about its state. This is the correct boundary: unbranded middleware that happens to track time or budget is a user-code concern, not a reset-contract concern.

**Replacing the name-based legacy predicate:** `hasIterationGuardBrand(mw)` checks for `ITERATION_GUARD_BRAND` ownership (the symbol check already in `isIterationGuardHandle`). The old name-based `isLegacyIterationGuard` predicate (matching `mw.name === "koi:iteration-guard"`) is removed — it was the wrong abstraction. The brand IS the contract; names are not. Legacy guards that predate the brand will not be caught by this helper — they must be migrated to carry the brand + `resetForRun()` before `resetBudgetPerRun: true` is set.

**Construction-time gate** remains: `createKoi()` throws `KoiError` if `resetBudgetPerRun: true` and any middleware in the initial set carries `ITERATION_GUARD_BRAND` without `resetForRun()`. The runtime gate in `resetRunBoundary()` catches dynamically composed guards (from forge/`applyRecomposition()`) that slip through construction-time validation.

No `run_reset_partial` kind — `run_reset` always represents a complete successful reset.

Both adapter paths replace their current inline duplicate sequences with a single `resetRunBoundary(...)` call.

**Timing: non-cooperating adapters reset at `run_start`; cooperating adapters reset at end of `applyRecomposition()`.**

These timings are not unified — they are intentionally different because the set of guards that must be reset differs:

- **Non-cooperating adapter**: the guard set is fixed at `run_start` (no dynamic composition). `resetRunBoundary()` is called immediately at run entry.
- **Cooperating adapter**: forge and `dynamicMiddleware()` can introduce new guards during `applyRecomposition()`. `resetRunBoundary()` is called as the last step of `applyRecomposition()`, targeting the final middleware snapshot. This ensures every guard that will execute in the new run is reset before the first turn.

**Cooperating-adapter invariant — enforced by type signature, not just prose:**

`applyRecomposition()` accepts `readonly` middleware descriptors (manifests, forge outputs, middleware config), never live guard instances. The function signature is:

```typescript
function applyRecomposition(
  previousDescriptors: readonly MiddlewareDescriptor[],
  dynamicDescriptors: readonly MiddlewareDescriptor[],
  cachedTerminals: readonly Terminal[],
): ReadonlySet<KoiMiddleware>  // returns new snapshot; resetRunBoundary() called on this
```

`MiddlewareDescriptor` is a `readonly` value type (factory function + config). It does not contain live guard instances. Live guard instances (`KoiMiddleware`) are only created when `applyRecomposition()` instantiates them from descriptors, after which `resetRunBoundary()` resets them. This type boundary makes it structurally impossible for recomposition logic to read mutable guard state: it doesn't have access to the live instances until after it returns them to `resetRunBoundary()`.

**What `resetRunBoundary()` unifies:** the reset logic (predicate, governance emit, deterministic boundaryId, fail-closed on unresettable guards). The call site timing differs per adapter but is now documented and tested explicitly.

#### 2b. Rename config option (hard rename, no alias)

`CreateKoiOptions.resetIterationBudgetPerRun` → `resetBudgetPerRun`

Hard rename, same philosophy as the event kind rename. All callers are internal to the monorepo; TypeScript compile errors enforce the update. No deprecated alias — accepting both names without defined precedence creates a misconfiguration hazard (callers could set old and new fields to different values with unpredictable behavior).

```typescript
// In CreateKoiOptions — old field removed, new field only:
readonly resetBudgetPerRun?: boolean
```

#### 2c. Add `boundaryId` to `session_reset` emission

`koi.ts:2348` (inside `cycleSession()`) — add `source: "host"` and a deterministic `boundaryId` to the existing `session_reset` record call. Format: `${currentSessionId}:session:${sessionCycleIndex}` where `sessionCycleIndex` is a per-runtime monotonic counter incremented on each `cycleSession()` call. This keeps replay fixtures stable, consistent with the `run_reset` derivation contract.

---

### Section 3: Tests

#### 3a. Unit — `guards.test.ts` (new `describe` block)

Drive `createIterationGuard` through 2 sequential `resetForRun()` calls with real `setTimeout`:

- Assert `turns`, `startedAt`, `lastActivityMs` all reset to run-start timestamp after `resetForRun()`
- Assert the guard does **not** throw on the second run after hitting its limit on the first run (direct regression for #1917 stale-duration bug)

#### 3b. Integration — `reset-boundary.integration.test.ts` (new file, alongside `activity-timeout.integration.test.ts`)

Three test cases, all using `createKoi()` with mock adapters (no LLM):

**Case 1 — Non-cooperating adapter, full reset:**
- Call `runtime.run()` twice sequentially — first run exhausts max turns, second run succeeds
- Assert `run_reset` fires between runs with `source: "engine"` and deterministic `boundaryId` (`${sessionId}:run:1`)
- Assert no guard state from run 1 (turns, duration) is visible during run 2
- Assert `session_reset` fires on `runtime.cycleSession()` with `source: "host"` and `boundaryId` (`${sessionId}:session:1`)
- Assert the two `boundaryId` values are distinct

**Case 2 — Cooperating adapter, full reset:**
- Same as Case 1 but using a cooperating adapter with at least one dynamic middleware guard
- Asserts that the dynamically added guard from run 2 is included in the reset sweep (not just guards present at run_start)
- Verifies reset occurs after `applyRecomposition()` completes, before first turn of run 2

**Case 3 — Legacy guard, fail-closed at construction:**
- Attempt to `createKoi({ resetBudgetPerRun: true, middleware: [legacyGuard] })` where `legacyGuard` has `name === "koi:iteration-guard"` but no `resetForRun()`
- Assert `createKoi()` throws a `KoiError` at construction time
- Assert the error message identifies the incompatible guard by name
- Assert no `run_reset` event is emitted (the runtime never starts)

This is the primary regression test matrix the issue requires.

#### 3c. Golden replay — `multi-submit` cassette (new entry)

- New `QueryConfig` in `packages/meta/runtime/scripts/record-cassettes.ts`: two sequential user submits, tool call on the first
- Cassette captures both model responses
- Trajectory assertion in `golden-replay.test.ts`: `run_reset` event appears in ATIF trajectory between submit 1 `done` and submit 2 `turn_start`

Satisfies the acceptance criterion: "Golden replay includes one multi-submit flow validating reset parity."

---

### Section 4: Docs

**New file:** `docs/L2/reset-boundaries.md`

Documents the canonical boundary → event mapping table, the `RESET_BOUNDARIES` constant, and the invariant: "never split paired guard + governance resets across call sites." Referenced from CLAUDE.md agent rules.

---

## Acceptance Criteria Mapping

| Issue criterion | Covered by |
|-----------------|-----------|
| Single documented reset contract | `RESET_BOUNDARIES` const + `docs/L2/reset-boundaries.md` |
| Duration/inactivity/turn counters reset at defined boundaries | `resetRunBoundary()` helper consolidation |
| Regression test for stale-duration behavior | Integration test 3b |
| Trace output explains which reset fired, where, why | `source` + `reason` + `boundaryId` on all reset events |
| Golden replay with multi-submit flow | Golden cassette 3c |

---

## Schema Migration Safety

The new required fields (`source`, `boundaryId`) and optional `reason` are wire-format changes. Wire compatibility is not a risk here for three reasons:

1. **Single-process, same-deploy:** `@koi/engine` and all governance consumers (`governance-controller.ts`, `in-memory-controller.ts`, golden replay) are compiled and deployed as one monorepo build. There is no rolling-deploy window where old consumers coexist with a new producer. Producer and all consumers change atomically in the same PR.

2. **TypeScript compile-time enforcement:** The `GovernanceEvent` union is a discriminated union with exhaustive `switch` in all consumers. Adding required fields causes a compile error in every consumer that constructs or destructures the event. The PR cannot pass `bun run typecheck` until every consumer is updated — it is mechanically impossible to ship a mismatched pair.

3. **No persisted payloads:** Governance events are in-memory only in v2. No historical event payloads exist that could be deserialized against the old schema. Replay cassettes are re-recorded as part of the PR.

All producers (engine paths, `cycleSession()`) and all consumers are updated together in the same commit set.

## What This Does Not Do

- Does not add a `turn_reset` event — not in the issue's acceptance criteria
- Does not add parent event chaining (`parentBoundaryId`) — no precedent in CC or v1; YAGNI
- Does not change error-rate reset boundary (session-scoped by design, documented as intentional)

---

## File Impact Summary

| File | Change |
|------|--------|
| `packages/kernel/core/src/governance.ts` | Rename event, add provenance fields, add `RESET_BOUNDARIES` const |
| `packages/kernel/engine/src/koi.ts` | Extract `resetRunBoundary()`, wire both adapter paths, add `boundaryId` to `cycleSession()`, add legacy-guard fail-closed check at `createKoi()` |
| `packages/kernel/engine/src/types.ts` | Rename `resetIterationBudgetPerRun` → `resetBudgetPerRun` (hard rename, no alias); add `MiddlewareDescriptor` readonly type for `applyRecomposition()` signature |
| `packages/kernel/engine-compose/src/guards.test.ts` | New `describe` block for reset regression |
| `packages/meta/runtime/src/__tests__/reset-boundary.integration.test.ts` | New integration test file |
| `packages/meta/runtime/scripts/record-cassettes.ts` | New `multi-submit` query config |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | New trajectory assertions |
| `docs/L2/reset-boundaries.md` | New doc |

**Estimated LOC:** ~350 (logic: ~150, tests: ~150, docs: ~50)
