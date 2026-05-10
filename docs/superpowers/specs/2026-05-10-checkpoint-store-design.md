# `CompositionCheckpointStore` — design (#1301 Part 2 foundation)

**Issue:** #1301 Part 2 — Temporal-durable compositions (foundation slice)
**Date:** 2026-05-10
**Package:** `@koi/proactive`

## Purpose

Define the **checkpoint** contract a future Temporal-backed composition
executor will use to survive process restarts. This slice ships the
interface and a deterministic in-memory implementation. Executor
wiring + Temporal-backed implementation are explicit follow-up slices.

## Why a separate primitive (not reuse `CompositionExecutionLog`)

`CompositionExecutionLog` (already in `composition-executor.ts`) is a
*per-side-effect dedupe ledger*: `claim(stepKey)` → run → `record` or
`release`. It guarantees a step's side effect runs at most once across
retries; it does NOT model **plan progress**.

The checkpoint store is *per-plan progress*: "I executed steps 0..k, the
last snapshot is X; restart from k+1". Different lifetime, different
key shape, different semantics. The two coexist — the execution log
keeps step-level dedupe; the checkpoint store enables coarse-grained
plan resume.

## Surface

```typescript
import type { JsonValue } from "@koi/core";

export type CheckpointPhase = "in_progress" | "completed" | "failed";

export interface CheckpointSnapshot {
  readonly executionId: string;
  /**
   * Stable hash of the plan being executed. On `load`, the executor
   * compares this with the hash of its current plan and discards the
   * snapshot if they diverge (plan rewritten between attempts).
   */
  readonly planHash: string;
  /**
   * Index of the NEXT step to execute. `0` = nothing run yet.
   * `plan.steps.length` = all steps complete.
   */
  readonly nextStepIndex: number;
  /**
   * Results of steps already executed, in order. `stepResults.length`
   * MUST equal `nextStepIndex`.
   */
  readonly stepResults: readonly JsonValue[];
  readonly phase: CheckpointPhase;
  /**
   * Wall-clock from injected `now()` at the time of save. Useful for
   * stale-snapshot detection by callers (executor decides policy).
   */
  readonly savedAt: number;
}

export interface CompositionCheckpointStore {
  readonly save: (snapshot: CheckpointSnapshot) => void | Promise<void>;
  readonly load: (executionId: string) => CheckpointSnapshot | undefined | Promise<CheckpointSnapshot | undefined>;
  readonly delete: (executionId: string) => void | Promise<void>;
}

export function createInMemoryCheckpointStore(): CompositionCheckpointStore;
```

## In-memory implementation semantics

| Op | Behavior |
|---|---|
| `save(snap)` | Replaces any existing snapshot for `executionId`. Snapshot stored by reference — caller is expected to pass a fresh, immutable snapshot each time (all fields are `readonly`). |
| `load(id)` | Returns the most-recent saved snapshot for `id`, or `undefined` if nothing was saved (or it was deleted). |
| `delete(id)` | Removes the entry. No-op if absent (idempotent). |

All three operations are synchronous in the in-memory impl, but the
interface returns `T \| Promise<T>` so a durable backend (Temporal,
SQLite, Redis) can implement the same contract.

## Invariants (enforced at factory or save-time)

- `stepResults.length === nextStepIndex` — checked in `save`. Throws if violated.
- `nextStepIndex >= 0` — checked in `save`. Throws if violated.
- `planHash` non-empty — checked in `save`. Throws if violated.
- `executionId` non-empty — checked in `save`. Throws if violated.

These are caller-bug conditions, not runtime errors → throw with
descriptive message. The interface does not constrain what `JsonValue`
results look like; that's the executor's responsibility.

## Tests (10 deterministic, in-memory)

| # | Test |
|---|---|
| 1 | `load` before any `save` returns `undefined` |
| 2 | `save` then `load` returns the saved snapshot verbatim |
| 3 | `save` twice with same `executionId` — `load` returns the latest |
| 4 | `save` with different `executionId`s — `load` returns the right one per id |
| 5 | `delete` removes the snapshot — subsequent `load` returns `undefined` |
| 6 | `delete` of unknown id is a no-op (does not throw) |
| 7 | `save` throws when `stepResults.length !== nextStepIndex` |
| 8 | `save` throws when `nextStepIndex < 0` |
| 9 | `save` throws when `planHash` or `executionId` is empty string |
| 10 | Returned snapshot reference does not allow mutation (TypeScript readonly enforcement is sufficient — assert at runtime that the stored object's fields match what was passed in, even after caller-side mutation attempts on a *copy* — proves the store doesn't share references with caller mutations). |

(Test 10 is a smoke check: caller mutates a local copy → store's
snapshot is unaffected. With `readonly` everywhere this is structurally
guaranteed; the test documents the intent.)

## Out of scope (explicit follow-ups)

1. **Executor wiring** — calling `store.load` before the step loop and
   `store.save` after each step inside `createCompositionExecutor`.
   `composition-executor.ts` is 1089 lines and touches many error paths;
   wiring belongs in its own focused PR with executor-level tests.
2. **Temporal-backed implementation** — wraps a Temporal workflow's
   internal state. Requires `@koi/temporal` worker setup and
   integration tests against a devserver.
3. **SQLite-backed implementation** — analogous to
   `composition-execution-log-sqlite.ts`. Useful for hosts that want
   crash-safe checkpoints without Temporal.
4. **Plan-hash helper** — a `hashCompositionPlan(plan)` function.
   Belongs with the executor wiring slice so the hash format is decided
   in context.

## Files

| File | Δ | Responsibility |
|---|---|---|
| `packages/lib/proactive/src/composition-checkpoint-store.ts` (new) | ~75 | Interface + in-memory impl + invariant checks |
| `packages/lib/proactive/src/composition-checkpoint-store.test.ts` (new) | ~200 | 10 tests |
| `packages/lib/proactive/src/index.ts` | +4 | Public exports |
| `docs/L2/proactive.md` | +25 | "Composition checkpoints" subsection |
| `docs/L3/runtime.md` | +1 | Changelog |

## Layer compliance

L2 — `composition-checkpoint-store.ts` imports only `JsonValue` from
`@koi/core`. No L1 or peer L2 dependencies. Future durable backends
will live in their own packages (e.g. `composition-checkpoint-store-sqlite.ts`
co-located, or a separate `@koi/temporal` integration).
