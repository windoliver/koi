# Reset Boundaries

Koi defines three canonical reset boundaries. This document is the authoritative
reference for which governance event fires at each boundary and what state resets.

## Boundary → Event Table

| Boundary | When | Governance event | Requires |
|----------|------|-----------------|---------|
| `turn_end` | One model API round-trip completes | None | — |
| `run_start` | `runtime.run()` called by host | `run_reset` | `resetBudgetPerRun: true` |
| `session_cycle` | `runtime.cycleSession()` called | `session_reset` | Always fires |

This table is also available as a typed constant:

```typescript
import { RESET_BOUNDARIES } from "@koi/core";
// RESET_BOUNDARIES.run_start === "run_reset (only when resetBudgetPerRun: true)"
```

## What Resets at Each Boundary

### `run_reset` (when `resetBudgetPerRun: true`)

Resets **per-run UX budgets only:**
- `turn_count` → 0
- `duration_ms` start → now

Does NOT reset:
- Token usage (runtime-wide spend ceiling)
- Accumulated cost (runtime-wide spend ceiling)
- Spawn counts (runtime-wide fan-out ceiling)
- Rolling error-rate windows (session-scoped)

### `session_reset`

Resets **per-session state:**
- Everything `run_reset` resets
- Rolling tool-error window → cleared
- Total-call window → cleared

Does NOT reset:
- Token usage, cost, spawn counts (same as above)

## Provenance Fields

Both `run_reset` and `session_reset` carry flat provenance fields:

```typescript
{
  kind: "run_reset" | "session_reset",
  source: "host" | "engine",   // who triggered the reset
  boundaryId: string,           // deterministic: `${sessionId}:run:${N}` or `:session:${N}`
  reason?: string,              // optional human-readable explanation
}
```

`boundaryId` is stable across golden replay — never a random UUID.

## Invariants (enforced)

1. **`run_reset` only on full success.** If any branded iteration guard cannot be
   reset (`resetForRun()` missing), `createKoi()` throws at construction time.
   There is no partial-reset state.

2. **`session_reset` always emitted.** `cycleSession()` unconditionally records
   `session_reset` before rotating the session ID.

3. **No reset outside these boundaries.** Do not call `governance.record({ kind: "run_reset" })`
   outside of `resetRunBoundary()`. Do not call `resetForRun()` outside of the same helper.

## Guard Capability Contract

Any middleware that tracks run-scoped mutable state (turns, duration, inactivity)
MUST carry `ITERATION_GUARD_BRAND` and implement `IterationGuardHandle.resetForRun()`.

```typescript
import { ITERATION_GUARD_BRAND } from "@koi/engine-compose";
// Apply brand:
Object.defineProperty(myGuard, ITERATION_GUARD_BRAND, { value: true, ... });
// Implement resetForRun():
myGuard.resetForRun = (runStartedAt?: number) => { /* reset your counters */ };
```

Unbranded middleware is not an iteration guard and is not affected by run-boundary resets.
