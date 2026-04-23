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

#### 1a. Rename `iteration_reset` → `run_reset`

The event fires at `run_start`, not at any "iteration" boundary. Rename aligns with Claude Code SDK vocabulary (`run()` call) and the issue's own boundary table.

New payload shape — flat provenance fields, consistent with Claude Code's `SessionStartHookInput.source` pattern and Koi v2's existing flat `reason` field on tool step metadata:

```typescript
| {
    readonly kind: "run_reset"
    readonly source: "host" | "guard" | "engine"
    readonly reason?: string
    readonly boundaryId: string  // opaque ID, not chained — generated at reset site
  }
```

`session_reset` keeps its kind name (already aligned with CC's `SessionEnd` hook), gains the same provenance fields:

```typescript
| {
    readonly kind: "session_reset"
    readonly source: "host" | "engine"
    readonly reason?: string
    readonly boundaryId: string
  }
```

#### 1b. Add `ResetBoundary` vocabulary constant

```typescript
export const RESET_BOUNDARIES = {
  turn_end:      "no governance event — turn counters are per-run, not per-turn",
  run_start:     "run_reset",
  session_cycle: "session_reset",
} as const satisfies Record<string, string>
```

This constant is the machine-readable form of the mapping table above. Agents and tools can import it; docs reference it.

#### 1c. Deprecate `iteration_reset` kind

Keep `iteration_reset` as a `@deprecated` union member for one release to avoid hard breaks in any existing governance controller consumers. Remove in the follow-up cleanup PR.

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
): { legacyGuardFound: boolean } {
  let legacyGuardFound = false
  for (const mw of guards) {
    if (isIterationGuardHandle(mw)) {
      mw.resetForRun(runStartedAt)
    } else if (isLegacyIterationGuard(mw)) {
      legacyGuardFound = true
    }
  }
  if (!legacyGuardFound) {
    governance.record({
      kind: "run_reset",
      source: "engine",
      boundaryId: crypto.randomUUID(),
    })
  }
  return { legacyGuardFound }
}
```

Where `isLegacyIterationGuard(mw)` detects a guard that carries `ITERATION_GUARD_BRAND` but has no `resetForRun()` method — the inverse of the existing `isIterationGuardHandle` predicate. Both predicates live in `engine-compose/src/guards.ts`.

Both adapter paths replace their current inline duplicate sequences with a single `resetRunBoundary(...)` call. The timing difference (immediate vs deferred via `applyRecomposition`) stays — that is intentional adapter-specific behavior. Only the duplicated logic is consolidated.

#### 2b. Rename config option

`CreateKoiOptions.resetIterationBudgetPerRun` → `resetBudgetPerRun`

Keep the old name as a `@deprecated` alias for one release:

```typescript
/** @deprecated Use resetBudgetPerRun */
readonly resetIterationBudgetPerRun?: boolean
```

#### 2c. Add `boundaryId` to `session_reset` emission

`koi.ts:2348` (inside `cycleSession()`) — add `source: "host"` and `boundaryId: crypto.randomUUID()` to the existing `session_reset` record call.

---

### Section 3: Tests

#### 3a. Unit — `guards.test.ts` (new `describe` block)

Drive `createIterationGuard` through 2 sequential `resetForRun()` calls with real `setTimeout`:

- Assert `turns`, `startedAt`, `lastActivityMs` all reset to run-start timestamp after `resetForRun()`
- Assert the guard does **not** throw on the second run after hitting its limit on the first run (direct regression for #1917 stale-duration bug)

#### 3b. Integration — `reset-boundary.integration.test.ts` (new file, alongside `activity-timeout.integration.test.ts`)

Full `createKoi()` with mock adapter (no LLM):

- Call `runtime.run()` twice sequentially — first run hits max turns, second run succeeds
- Spy on governance `record()` — assert `run_reset` fires between runs with `source: "engine"` and a non-empty `boundaryId`
- Assert `session_reset` fires on `runtime.cycleSession()` with `source: "host"` and a non-empty `boundaryId`
- Assert the two `boundaryId` values are distinct (each reset is a unique event)

This is the primary regression test the issue requires.

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

## What This Does Not Do

- Does not add a `turn_reset` event — not in the issue's acceptance criteria
- Does not remove `iteration_reset` kind immediately — one-release deprecation window
- Does not add parent event chaining (`parentBoundaryId`) — no precedent in CC or v1; YAGNI
- Does not change error-rate reset boundary (session-scoped by design, documented as intentional)

---

## File Impact Summary

| File | Change |
|------|--------|
| `packages/kernel/core/src/governance.ts` | Rename event, add provenance fields, add `RESET_BOUNDARIES` const |
| `packages/kernel/engine/src/koi.ts` | Extract `resetRunBoundary()`, wire both adapter paths, add `boundaryId` to `cycleSession()` |
| `packages/kernel/engine/src/types.ts` | Rename `resetIterationBudgetPerRun` → `resetBudgetPerRun` with deprecated alias |
| `packages/kernel/engine-compose/src/guards.test.ts` | New `describe` block for reset regression |
| `packages/meta/runtime/src/__tests__/reset-boundary.integration.test.ts` | New integration test file |
| `packages/meta/runtime/scripts/record-cassettes.ts` | New `multi-submit` query config |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | New trajectory assertions |
| `docs/L2/reset-boundaries.md` | New doc |

**Estimated LOC:** ~350 (logic: ~150, tests: ~150, docs: ~50)
