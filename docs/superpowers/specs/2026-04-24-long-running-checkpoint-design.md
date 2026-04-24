# `@koi/long-running` — Agent Checkpointing (Issue #1386)

**Status:** Design approved 2026-04-24
**Issue:** [#1386](https://github.com/windoliver/koi/issues/1386) — v2 Phase 3-sched-2: long-running agent checkpointing
**Scope estimate:** ~500 LOC
**Layer:** L2 (feature package)

## Purpose

Enable Koi agents to run over hours or days across many sessions. Provide atomic
checkpoint/resume, progress tracking, timeout enforcement, and abandonment cleanup
for long-running harnesses.

## Non-Goals

The following concerns from v1 `@koi/long-running` are **out of scope** for this
issue and will be addressed in follow-up packages when needed:

- Delegation bridge (spawn/handoff between harnesses)
- Inbox middleware (cross-harness messaging)
- Plan-autonomous tool
- Task tools (task board CRUD exposed as agent tools)
- Thread compaction (handled by `@koi/context-manager`)
- Semaphores / lane concurrency
- Autonomous provider (scheduler integration — separate sched-* issue)
- Process-level supervision (`@koi/daemon` already owns this)

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│ Host (CLI / scheduler / daemon)                           │
│   ↓ createLongRunningHarness(cfg)                         │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ LongRunningHarness                                    │ │
│ │   start() ─┐                                          │ │
│ │   resume() ├─→ EngineInput (phase=active, AbortSig)   │ │
│ │   pause()  ┘                                          │ │
│ │   fail() / status() / dispose()                       │ │
│ │   createMiddleware() ──→ afterTurn: soft checkpoint   │ │
│ └──────────┬────────────────────────┬───────────────────┘ │
│            ↓                        ↓                     │
│     HarnessSnapshotStore      SessionPersistence          │
│     (atomic CAS pointer)      (crash-recovery records)    │
└───────────────────────────────────────────────────────────┘
```

The harness is a thin state machine over L0 `HarnessPhase`
(`idle → active ↔ suspended → completed | failed`) backed by two pluggable
L0 interfaces. It owns zero I/O directly; all durability is delegated.

## Layer Contract

- **Depends on:** `@koi/core` (L0) only.
- **Imports from L2:** none.
- **Exports:** runtime functions + config types. No framework types leak out.

`SessionPersistence`, `HarnessSnapshotStore`, `HarnessStatus`, `HarnessSnapshot`,
`HarnessPhase`, `HarnessMetrics`, `ContextSummary`, `KeyArtifact`, `PruningPolicy`,
`CheckpointPolicy`, `DEFAULT_CHECKPOINT_POLICY`, `TaskBoardSnapshot`, `KoiError`,
`Result` all come from `@koi/core` — no new L0 types introduced.

## Public Surface

```ts
// index.ts
export { createLongRunningHarness } from "./harness.js";
export { createCheckpointMiddleware } from "./checkpoint-middleware.js";
export { computeCheckpointId, shouldSoftCheckpoint } from "./checkpoint-policy.js";
export type {
  LongRunningConfig,
  LongRunningHarness,
  StartResult,
  ResumeResult,
  SessionResult,
  SaveStateCallback,
  OnCompletedCallback,
  OnFailedCallback,
  CheckpointMiddlewareConfig,
} from "./types.js";
export { DEFAULT_LONG_RUNNING_CONFIG } from "./types.js";
```

### `LongRunningConfig`

```ts
interface LongRunningConfig {
  readonly harnessId: HarnessId;
  readonly agentId: AgentId;
  readonly harnessStore: HarnessSnapshotStore;
  readonly sessionPersistence: SessionPersistence;
  readonly softCheckpointInterval?: number;   // turns between soft checkpoints (default 5)
  readonly maxKeyArtifacts?: number;          // default 10
  readonly pruningPolicy?: PruningPolicy;     // default { retainCount: 10 }
  readonly timeoutMs?: number;                // optional wall-clock deadline per session
  readonly saveState?: SaveStateCallback;     // capture engine state on soft checkpoint
  readonly onCompleted?: OnCompletedCallback;
  readonly onFailed?: OnFailedCallback;
}
```

### `LongRunningHarness`

```ts
/** Opaque token proving the caller owns the currently-active session. */
interface SessionLease {
  readonly sessionId: string;
  readonly generation: number; // monotonic per harness, persisted
}

interface LongRunningHarness {
  readonly harnessId: HarnessId;
  readonly start: (plan: TaskBoardSnapshot) => Promise<Result<StartResult, KoiError>>;
  readonly resume: () => Promise<Result<ResumeResult, KoiError>>;
  readonly pause: (lease: SessionLease, session: SessionResult) => Promise<Result<void, KoiError>>;
  readonly fail: (lease: SessionLease, err: KoiError) => Promise<Result<void, KoiError>>;
  readonly completeTask: (
    lease: SessionLease,
    id: TaskItemId,
    result: TaskResult,
  ) => Promise<Result<void, KoiError>>;
  readonly failTask: (
    lease: SessionLease,
    id: TaskItemId,
    err: KoiError,
  ) => Promise<Result<void, KoiError>>;
  readonly status: () => HarnessStatus;
  readonly createMiddleware: (lease: SessionLease) => KoiMiddleware;
  readonly dispose: () => Promise<void>;
}
```

`StartResult` and `ResumeResult` both carry a fresh `SessionLease`. Callers pass
it back on every mutating call; stale leases are rejected with
`KoiError { code: "STALE_SESSION" }`.

## Behavior

### Phase Machine

| From → To | Trigger | Snapshot? |
|-----------|---------|-----------|
| `idle → active` | `start(plan)` | yes (initial) |
| `active → active` | turn completes, policy fires | yes (soft) |
| `active → suspended` | `pause(sessionResult)` | yes (with summary + artifacts) |
| `suspended → active` | `resume()` | no (read-only) |
| `active → completed` | last task done via `completeTask` | yes (final) |
| `active → failed` | `fail(err)` or timeout | yes (best-effort) |
| any → any (other) | rejected with `KoiError` code=`INVALID_STATE` |

### Atomic Checkpoint Write

Issue requirement: **no partial writes**.

```
1. Build HarnessSnapshot in memory (immutable).
2. harnessStore.put(snapshot) — L0 SnapshotChainStore contract guarantees:
     a. Payload written to durable storage first.
     b. Chain pointer advanced via CAS.
     c. On failure at any step, previous chain head remains authoritative.
3. If step 2 fails: log, retain in-memory state, do not advance phase.
```

We never mutate stored state in place. A crashed write leaves the prior snapshot
as the valid resume point. This matches v1 behavior and relies on
`SnapshotChainStore` (already validated in L0).

### Resume — Exclusive Lease Protocol

Concurrent resume attempts must not both produce an active session. The lease
protocol below fences duplicate execution:

1. Read `harnessStore.latest()` → `prev: HarnessSnapshot | undefined`.
   - Undefined → `KoiError { code: "NOT_FOUND" }`.
   - `prev.phase ∈ { completed, failed }` → `KoiError { code: "TERMINAL" }`.
   - `prev.phase === "active"` → `KoiError { code: "ALREADY_ACTIVE", retryable: true }`
     (a peer holds the lease; caller can retry after a bounded wait).
2. Build `next: HarnessSnapshot` from `prev` with:
   `phase = "active"`, `sessionSeq = prev.sessionSeq + 1`,
   `generation = prev.generation + 1`, `lastSessionId = newSessionId`.
3. `harnessStore.compareAndPut(prev.chainHead, next)` — CAS-conditioned advance.
   If CAS fails (another caller raced us) → `KoiError { code: "CONCURRENT_RESUME", retryable: true }`.
4. Only after CAS success: mint a `SessionLease { sessionId, generation }`,
   mark session "running" via `sessionPersistence.setSessionStatus`, build resume
   context, return `ResumeResult` carrying the lease.

`start()` uses the same protocol with `prev === undefined` as the precondition
(the CAS tolerates absence → initial snapshot).

All mutating calls (`pause`, `fail`, `completeTask`, `failTask`, checkpoint
middleware writes) take the `SessionLease` as an explicit argument. Before every
store write, the harness asserts `lease.generation === currentSnapshot.generation`.
Stale leases (timed-out sessions, superseded runs) are rejected with
`KoiError { code: "STALE_SESSION", retryable: false }` and their writes are
never persisted. This closes the "late callback after timeout" and "replacement
session already claimed the harness" races.

Requires L0 support: `HarnessSnapshot.generation: number` and
`SnapshotChainStore.compareAndPut(expectedHead, next)`. If either is missing,
add them as a prerequisite L0 PR before implementing this L2 package — the
design does not regress to lease-less semantics.

### Progress Tracking

Derived from `HarnessStatus`, not stored separately:

- `taskBoard.tasks` provides completed/pending counts.
- `metrics.totalTurns`, `metrics.completedTaskCount` accumulate across sessions.
- `status()` is pure — safe to call at any time from any caller.

### Timeout

- Optional `timeoutMs` in config.
- On `start()` / `resume()`: harness creates an `AbortController` with
  `setTimeout(controller.abort, timeoutMs)`.
- `AbortSignal` is attached to the returned `EngineInput`; the caller MUST wire
  it into the engine adapter.
- **On timeout fire, the harness revokes the active lease FIRST** (advances
  `generation` via CAS to an intermediate `failed` snapshot), then invokes
  `onFailed`. Any subsequent callback from the aborted run — even late
  `completeTask` / `failTask` calls — presents a stale lease and is rejected
  with `STALE_SESSION`. This prevents a cooperative-but-slow adapter from
  writing after the harness has moved on.
- Best-effort final snapshot carries `failureReason = "TIMEOUT"`.

### Cleanup on Abandonment

`dispose()` is idempotent:

1. Clear any pending timeout timers.
2. If phase is `active`: attempt one last snapshot with phase=`suspended`,
   `failureReason="disposed before completion"`. Best-effort — errors logged, not thrown.
3. Release references to stores (callers own their lifecycle).

No process-level cleanup (kill subprocess, close sockets) — that's `@koi/daemon`.

### Checkpoint Middleware

```ts
createCheckpointMiddleware({
  harness,
  lease,                              // SessionLease for the current run
  onDurabilityLost,                   // required — host escalation callback
  policy?,
  continueWithoutDurability?: boolean // default false; explicit opt-in for in-memory-only
}): KoiMiddleware
```

Single hook: `afterTurn`. On each turn boundary:

1. `shouldSoftCheckpoint(turnCount, policy.interval)` → bool.
2. If false: return.
3. Capture `EngineState` via `cfg.saveState?.()`, build snapshot with current
   `lease.generation`, call `harnessStore.compareAndPut(expectedHead, next)`.
4. **On CAS success:** update in-memory head reference. Return.
5. **On CAS failure where `expectedHead` mismatches** (another writer raced or
   our lease was revoked): treat as `STALE_SESSION`, fail the turn with that
   error, invoke `onDurabilityLost` with the error, revoke our local lease.
6. **On CAS failure due to store I/O error:** escalate. The harness is marked
   `unhealthy`; `status().phase` remains what it was but `status().durability`
   flips to `"lost"`. The middleware:
   - If `continueWithoutDurability === true`: emit warning event, allow the
     turn to continue (caller accepted the risk).
   - Otherwise (default): fail the turn with
     `KoiError { code: "CHECKPOINT_WRITE_FAILED", retryable: true }`, invoke
     `onDurabilityLost`, and transition the harness to `suspended` (best-effort
     snapshot skipped — durability is already broken).

Rationale: a package whose entire purpose is durable long-running state must
not silently degrade to memory-only. Silent failure turns an eventual crash
into unrecoverable progress loss with no signal to the scheduler. The default
fails loudly; operators who genuinely want memory-only continuation must opt
in per-harness.

## File Layout

```
packages/lib/long-running/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── scripts/
│   └── check-api-surface.ts     # optional — follows existing pkg pattern
└── src/
    ├── index.ts                 # ~25 LOC
    ├── types.ts                 # ~90 LOC
    ├── harness.ts               # ~250 LOC
    ├── checkpoint-policy.ts     # ~60 LOC — pure
    ├── checkpoint-middleware.ts # ~75 LOC
    └── __tests__/
        ├── harness.test.ts
        ├── checkpoint-middleware.test.ts
        ├── checkpoint-policy.test.ts
        └── api-surface.test.ts
```

Target total: ~500 LOC implementation, excluding tests (per issue estimate).

## Testing

All tests use `bun:test`. Coverage threshold ≥ 80% enforced by `bunfig.toml`.

### Unit: `harness.test.ts`

- `start()` writes initial snapshot and returns `EngineInput` with valid `AbortSignal`.
- `start()` rejects when phase ≠ `idle`.
- `resume()` reads latest snapshot, increments `sessionSeq`, emits resume context.
- `resume()` on terminal phase returns `TERMINAL` error.
- `pause()` persists `SessionResult` + advances phase to `suspended`.
- `completeTask()` updates task board, emits `onCompleted` when all tasks done.
- `failTask()` with retryable error returns task to `pending`.
- `timeout` fires `fail()` with `TIMEOUT` error and attempts final snapshot.
- `dispose()` is idempotent and writes abandonment snapshot.
- `status()` returns current state without mutation.

### Unit: `checkpoint-middleware.test.ts`

- Fires soft checkpoint every `softCheckpointInterval` turns.
- CAS success advances head; subsequent soft checkpoint uses new head.
- **Default behavior:** store I/O failure fails the turn with
  `CHECKPOINT_WRITE_FAILED`, invokes `onDurabilityLost`, transitions harness to
  `suspended`. No silent degradation.
- **Opt-in:** `continueWithoutDurability=true` keeps the turn running on I/O
  failure but still invokes `onDurabilityLost`.
- `saveState` thrown exception fails the turn cleanly (no snapshot written).
- **Atomicity invariant:** simulated crash between put-payload and advance-pointer
  leaves store readable at prior snapshot.
- **Stale-lease rejection:** checkpoint attempt with a revoked lease is rejected
  with `STALE_SESSION` and does not mutate the store.

### Unit: race tests (`harness.test.ts`)

- **Double resume:** two concurrent `resume()` calls on the same suspended
  harness — exactly one succeeds, the other returns `CONCURRENT_RESUME` or
  `ALREADY_ACTIVE`.
- **Late callback after timeout:** timeout fires → harness revokes lease →
  subsequent `completeTask(oldLease, …)` returns `STALE_SESSION` and does not
  mutate the snapshot.
- **Stale writer vs. replacement session:** `start` → `pause` → `resume` mints a
  new lease; an in-flight caller holding the first lease attempts
  `completeTask` → rejected with `STALE_SESSION`; new lease's writes succeed.

### Unit: `checkpoint-policy.test.ts`

- `shouldSoftCheckpoint` boundary cases (0, interval, interval+1).
- `computeCheckpointId` deterministic + collision-resistant across harnesses.

### API surface: `api-surface.test.ts`

- Snapshot of `typeof import("./index.js")` — guards public surface changes.

### Regression fixtures for issue requirements

| Issue requirement | Test |
|-------------------|------|
| Checkpoint saves agent state | `harness.test.ts` — start/pause/resume roundtrip |
| Resume restores from checkpoint | `harness.test.ts` — resume emits identical summaries + artifacts |
| Progress tracked across checkpoints | `harness.test.ts` — metrics.totalTurns monotonic across sessions |
| Timeout stops long-running agent | `harness.test.ts` — timeout fires `fail(TIMEOUT)` |
| Abandoned agent cleaned up | `harness.test.ts` — dispose writes suspended snapshot |
| Checkpoint handles large state efficiently | `checkpoint-middleware.test.ts` — 10k-task plan snapshot ≤ 250ms |

## Golden Query / Runtime Wiring

Per CLAUDE.md rule "every new L2 package must be wired into `@koi/runtime`":

1. Add `@koi/long-running` as dependency of `packages/meta/runtime/package.json`.
2. Add 2 standalone golden queries in `golden-replay.test.ts`:
   - `Golden: @koi/long-running — checkpoint + resume roundtrip`
   - `Golden: @koi/long-running — timeout triggers fail`
3. Add a full-loop query (optional for this package since it's non-LLM-bound):
   A harness runs a 3-turn task, process "restarts" (new harness instance, same store),
   resume replays from snapshot, completes the task. No cassette needed — deterministic.

CI gates:
```bash
bun run check:orphans
bun run check:golden-queries
bun run test --filter=@koi/long-running
bun run test --filter=@koi/runtime
```

## Error Taxonomy

All errors are `KoiError` from L0. Codes used:

| Code | When | Retryable |
|------|------|-----------|
| `NOT_FOUND` | `resume()` with no snapshot | false |
| `TERMINAL` | action on completed/failed harness | false |
| `INVALID_STATE` | phase transition not allowed | false |
| `TIMEOUT` | session exceeded `timeoutMs` | false |
| `ALREADY_ACTIVE` | `resume()` while another session holds an active lease | true |
| `CONCURRENT_RESUME` | CAS failed: peer claimed the lease first | true |
| `STALE_SESSION` | mutating call presented a revoked/superseded lease | false |
| `CHECKPOINT_WRITE_FAILED` | store `put`/`compareAndPut` rejected (I/O) | true |
| `RESUME_CORRUPT` | snapshot fails `isHarnessSnapshot` | false |

## References

- v1 archive: `archive/v1/packages/sched/long-running/` — blueprint for the runtime
  (28K LOC; we port only the harness + checkpoint subset, ~500 LOC).
- L0 contract: `packages/kernel/core/src/harness.ts`, `session.ts`, `snapshot-chain.ts`.
- Claude Code: `src/tasks/LocalMainSessionTask.ts` — validates the
  background/resume/notify UX pattern (single-process analogue).

## L0 Prerequisites

This design requires two additions to `@koi/core` before the L2 package can be
implemented:

1. `HarnessSnapshot.generation: number` — monotonic per harness, incremented on
   every session transition. Drives lease fencing.
2. `SnapshotChainStore.compareAndPut(expectedHead, next)` — CAS-conditioned
   advance. Existing `put` is insufficient for exclusivity guarantees.

Both are additive (backward-compatible) L0 changes and should land in a
prerequisite PR.

## Open Questions

None blocking. The design maps cleanly onto existing L0 contracts once the two
prerequisites above are added.

## Risks

- **Atomicity depends on `SnapshotChainStore` implementation.** We rely on its
  contract; if a specific store implementation lies about atomicity, the harness
  inherits that bug. Mitigation: document the contract requirement; add a
  conformance test in the default store's package.
- **Progress derivation may lag.** `metrics.elapsedMs` is snapshot-time, not
  live-time. Callers wanting live uptime compute it from `startedAt`. Acceptable.
