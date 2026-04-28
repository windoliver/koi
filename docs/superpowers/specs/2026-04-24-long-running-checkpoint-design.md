# `@koi/long-running` — agent checkpointing (issue #1386)

**Status:** Design — ready for implementation. Targets the existing L0
surface; introduces NO new persistence contracts (aligned with #1683).

**Date:** 2026-04-24

## Purpose

Provide a long-running harness for agents that operate over many turns,
across pause/resume cycles, without losing progress on crash. The harness
is the L2 wrapper around the existing engine loop that:

- Tracks task-board progress, summaries, and key artifacts across turns.
- Soft-checkpoints engine state at configurable cadence via the existing
  `EngineAdapter.saveState` / `SessionRecord.lastEngineState` pipeline.
- Snapshots harness-level progress to `HarnessSnapshotStore` (the existing
  DAG-style `SnapshotChainStore<HarnessSnapshot>`).
- Resumes from the last durable snapshot via `koi resume <sessionId>`.
- Quiesces the engine before publishing terminal phases so a paused/failed
  snapshot never coexists with running side effects.

## Scope of the Correctness Guarantee

This package provides:

1. **Durable harness state on clean transitions.** `pause`, `fail`,
   `completeTask`-terminal, and timeout transitions only publish their
   target phase after the engine has quiesced. A `suspended` /
   `completed` / `failed` snapshot in the store implies the engine has
   stopped emitting side effects in this process.
2. **At-most-once durable transitions for in-process operations.** A
   `SessionLease` (in-memory WeakSet identity) gates every mutating call;
   stale leases are rejected with `STALE_REF`. Two concurrent in-process
   pauses cannot both publish.
3. **Best-effort recovery from crash.** On restart, `koi resume
   <sessionId>` loads the last `lastEngineState` from
   `SessionPersistence` and the last `HarnessSnapshot` from
   `HarnessSnapshotStore`, then continues. Tools may re-execute (see
   below).

This package does NOT provide:

- **Exactly-once external side effects.** Tool calls that completed in
  the prior session but were not yet checkpointed will re-execute on
  resume. Callers requiring stronger guarantees use one of:
  1. **Idempotent tools** keyed by a stable `(harnessId, taskId, opId)`
     where `taskId` comes from the immutable `TaskBoardSnapshot` entry.
  2. **Transactional outbox** — queue side effects into harness state,
     publish via separate idempotent worker.
  3. **Epoch-fenced tools** — long-running tools accept and validate the
     current `lease.epoch` (in-memory monotonic counter) and reject calls
     from a superseded session.
- **Cross-process exclusivity.** Two processes can in principle resume
  the same session if the operator runs `koi resume` twice. The
  in-process WeakSet does not protect against this. The host's process
  manager (`@koi/daemon`, systemd, k8s) MUST ensure at most one process
  owns the session at a time. No supervisor contract is required by
  this package.
- **Automatic crash detection or peer takeover.** A crashed session
  remains `phase = "active"` in the snapshot store until the operator
  invokes `koi resume`. Detecting and acting on dead sessions is the
  scheduler's job, not this package's.
- **Forge-resistant lease.** The `SessionLease` is a WeakSet capability;
  it protects against bugs (stale callbacks, late completions) but not
  malicious in-process actors.

## Non-Goals

- L0 changes (intentional — this PR fits existing surface)
- Heartbeats / TTL reclaim / supervisor contracts
- WorkerHandle / kill-on-takeover
- RecoveryOutcome durable replay machinery
- `forceReclaim` admin API
- `cleanupHealth` durable breadcrumb
- Generation counters or CAS fencing
- Multi-process safety primitives
- Thread compaction (handled by `@koi/context-manager`)
- Autonomous provider integration (separate sched-* issue)

## Layer Contract

`@koi/long-running` is L2. It depends only on `@koi/core` (L0) and
selected L0u utilities. It does NOT depend on `@koi/engine` (L1) or
peer L2 packages.

L0 dependencies used (all exist today):
- `@koi/core/session` — `SessionRecord`, `SessionPersistence`,
  `SessionStatus` (`running|idle|done`), `SessionId`, `AgentId`
- `@koi/core/snapshot-chain` — `SnapshotChainStore`, `ChainId`, `NodeId`,
  `SnapshotNode`, `PruningPolicy`
- `@koi/core/harness` — `HarnessId`, `HarnessPhase`, `HarnessStatus`,
  `HarnessSnapshot`, `HarnessSnapshotStore`, `KeyArtifact`, `ContextSummary`,
  `HarnessMetrics`
- `@koi/core/task-board` — `TaskBoardSnapshot`, `Task`
- `@koi/core/engine` — `EngineState`, `EngineAdapter` (its
  `saveState`/`loadState` callbacks)
- `@koi/core/errors` — `KoiError`, `Result`, existing `KoiErrorCode`
  (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `TIMEOUT`, `STALE_REF`,
  `INTERNAL`, `EXTERNAL`)

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│ Host (CLI / scheduler / daemon)                           │
│   ↓ createLongRunningHarness(cfg)                         │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ LongRunningHarness                                    │ │
│ │   start() ─┐                                          │ │
│ │   resume() ├─→ EngineInput (phase=active, lease)      │ │
│ │   pause()  ┘                                          │ │
│ │   fail() / status() / dispose()                       │ │
│ │   createMiddleware() ──→ afterTurn: soft checkpoint   │ │
│ └──────────┬────────────────────────┬───────────────────┘ │
│            ↓                        ↓                     │
│     HarnessSnapshotStore      SessionPersistence          │
└───────────────────────────────────────────────────────────┘
```

The harness is a thin coordinator: lifecycle state machine + a
checkpoint middleware that hooks into the engine's `afterTurn`. The
engine adapter does the actual model/tool work; the harness records
progress and persists state.

## Public Surface

```ts
// index.ts
export { createLongRunningHarness } from "./harness.js";
export { createCheckpointMiddleware } from "./checkpoint-middleware.js";
export { computeCheckpointId, shouldSoftCheckpoint } from "./checkpoint-policy.js";
export type {
  LongRunningConfig,
  LongRunningHarness,
  SessionLease,
  StartResult,
  ResumeResult,
  SessionResult,
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

  /** Turns between soft checkpoints. Default 5. */
  readonly softCheckpointInterval?: number;

  /** Max key artifacts retained per harness. Default 10. */
  readonly maxKeyArtifacts?: number;

  /** Pruning policy for the snapshot chain. Default { retainCount: 10 }. */
  readonly pruningPolicy?: PruningPolicy;

  /** Wall-clock deadline per session. Optional. */
  readonly timeoutMs?: number;

  /** Max wait for engine to quiesce on phase transitions. Default 10_000. */
  readonly abortTimeoutMs?: number;

  /** Save engine state on soft checkpoint. */
  readonly saveState?: SaveStateCallback;

  /** Called when the harness completes (all tasks done). */
  readonly onCompleted?: OnCompletedCallback;

  /** Called when the harness fails. */
  readonly onFailed?: OnFailedCallback;
}
```

`createLongRunningHarness(cfg)` returns
`Result<LongRunningHarness, KoiError>`. Validation errors return
`KoiError { code: "VALIDATION", retryable: false }`.

### `LongRunningHarness`

```ts
interface LongRunningHarness {
  /** Begin a new session. Fails CONFLICT if already active. */
  readonly start: () => Promise<Result<StartResult, KoiError>>;

  /** Resume from the last durable snapshot. */
  readonly resume: () => Promise<Result<StartResult, KoiError>>;

  /** Quiesce the engine then publish phase=suspended. */
  readonly pause: (
    lease: SessionLease,
    sessionResult: SessionResult,
  ) => Promise<Result<void, KoiError>>;

  /** Quiesce the engine then publish phase=failed. */
  readonly fail: (
    lease: SessionLease,
    error: KoiError,
  ) => Promise<Result<void, KoiError>>;

  /** Mark a task complete. May trigger session-end (terminal) flow. */
  readonly completeTask: (
    lease: SessionLease,
    taskId: string,
    result: unknown,
  ) => Promise<Result<void, KoiError>>;

  /** Mark a task failed. Retryable failures keep the session active. */
  readonly failTask: (
    lease: SessionLease,
    taskId: string,
    error: KoiError,
  ) => Promise<Result<void, KoiError>>;

  /** Idempotent abandonment — quiesce then publish suspended. */
  readonly dispose: (
    lease?: SessionLease,
  ) => Promise<Result<void, KoiError>>;

  /** Read-only observable status. */
  readonly status: () => HarnessStatus;

  /** Construct the checkpoint middleware bound to this harness. */
  readonly createMiddleware: () => KoiMiddleware;
}
```

### `SessionLease`

```ts
interface SessionLease {
  readonly sessionId: SessionId;
  readonly epoch: number;        // monotonic per harness; in-memory only
  readonly abort: AbortSignal;
}
```

The lease is minted on `start` / `resume` and lives in a
`WeakSet<SessionLease>` inside the harness instance. Mutating calls
verify the supplied lease is the WeakSet member; identity equality is
the only authorization check. `epoch` is a defense-in-depth field that
tools MAY consult for stale-call rejection (see "Epoch-fenced tools" in
Scope). Forging a lease is not part of the threat model.

### `StartResult` / `SessionResult`

```ts
interface StartResult {
  readonly lease: SessionLease;
  readonly engineInput: EngineInput;
  readonly sessionId: SessionId;
}

interface SessionResult {
  readonly summary: ContextSummary;
  readonly newKeyArtifacts: readonly KeyArtifact[];
  readonly metricsDelta: Partial<HarnessMetrics>;
}
```

## Behavior

### Phase Machine

| From → To | Trigger | Quiesce-before-publish |
|-----------|---------|------------------------|
| `idle → active` | `start()` | n/a |
| `active → active` | soft checkpoint (afterTurn middleware) | no |
| `active → suspended` | `pause(lease, result)` | yes |
| `suspended → active` | `resume()` | n/a |
| `active → completed` | last task done via `completeTask` | yes |
| `active → failed` | `fail(lease, err)` or timeout | yes |
| any → any (other) | rejected with `KoiError` code=`VALIDATION` | — |

### Activation (`start` / `resume`)

1. Read `harnessStore.head(harnessId)`. Validate the transition:
   - `start()`: requires no head OR head.phase ∈ {`idle`, `completed`,
     `failed`}. Otherwise → `Err(CONFLICT)`.
   - `resume()`: requires head.phase = `suspended`. Otherwise → `Err(CONFLICT)`.
2. If head.phase = `active` (crash recovery on resume), accept it: a
   prior session crashed without publishing `suspended`. The operator
   has decided to resume; trust the decision. Use the head as the
   restart point. (No automatic peer-takeover — the host's process
   manager guarantees at-most-one-resumer.)
3. Mint a fresh `SessionId`, save a `SessionRecord` with
   `status = "running"` and `lastEngineState` carried forward from the
   prior head if present.
4. Mint a `SessionLease` with `epoch = previous.epoch + 1` (or 0 on
   first start), add to `activeLeases` WeakSet.
5. `put(chainId, nextSnapshot, [head?.nodeId ?? noParent])` to advance
   harness phase to `active`. If `put` fails on conflict (concurrent
   activation), stop heartbeat, `removeSession(sid)`, return
   `Err(CONFLICT, retryable: true)`.
6. Build `EngineInput` carrying the lease's `AbortSignal` and any
   `lastEngineState` for adapters that implement `loadState`.
7. Return `Ok(StartResult)`.

### Soft Checkpoint (in-session, non-quiescing)

Driven by the `createMiddleware()` middleware's `afterTurn` hook:

1. If `turnCount % softCheckpointInterval !== 0`, no-op.
2. Build the next `HarnessSnapshot` (phase still `active`, updated
   metrics + task-board state + summaries + key artifacts).
3. If `cfg.saveState` provided: capture engine state, persist via
   `sessionPersistence.saveSession({ ...prev, lastEngineState })`.
4. `put(chainId, nextSnapshot, [head.nodeId])`. On conflict, log and
   keep the lease — soft checkpoints are best-effort, the next turn
   will retry. On I/O error, return `Err(CHECKPOINT_WRITE_FAILED)` to
   the engine; whether to abort is the caller's choice.

Soft checkpoints never quiesce. They run inside the engine's normal
turn loop.

### Quiesce-Before-Publish (pause / fail / completeTask-terminal / timeout)

Applies to every transition that publishes a non-`active` phase or a
terminal phase. The algorithm:

1. Validate lease (WeakSet identity). Missing or stale → `Err(STALE_REF)`.
2. Revoke the lease (remove from WeakSet, fire `lease.abort`).
3. Signal the engine adapter to stop, then `await quiesce(abortTimeoutMs)`.
4. Branch on quiesce outcome:
   - **Quiescent:** build the target snapshot,
     `put(chainId, snapshot, [head.nodeId])`. On `put` conflict, retry
     once with the fresh head. On second failure, return
     `Err(CHECKPOINT_WRITE_FAILED)`. Caller can re-invoke the same
     transition (idempotent — repeat is observed by the phase check).
   - **Abort timeout:** the engine refused to stop within
     `abortTimeoutMs`. Do NOT publish. Return `Err(TIMEOUT)`. Document
     this as a degraded state — the harness remains `active` from the
     store's view; operator must SIGKILL the worker or wait for the
     engine to exit. There is no automatic recovery; the operator
     re-runs the operation after the engine quiesces.
5. Call `setSessionStatus(sid, "done")` on terminal transitions
   (`completed` / `failed`) or `setSessionStatus(sid, "idle")` on
   `suspended`. Best-effort; failure logs but does not fail the call.
6. Invoke `onCompleted` / `onFailed` callbacks if configured.

### Task-board updates: in-session vs session-ending

`completeTask` and `failTask` have two paths:

- **In-session:** task board still has pending tasks after the update.
  Run a soft checkpoint with the new task-board state. Lease remains
  valid. No quiesce.
- **Session-ending:** the update empties the task board (last task done
  for `completeTask`, or non-retryable `failTask` empties the board).
  Run the full quiesce-and-publish flow above with target phase
  `completed` (for `completeTask`) or `failed` (for non-retryable
  `failTask`).

Retryable `failTask` (where `error.retryable === true`) is always
in-session: the task is returned to `pending` with `attempts`
incremented; the engine will retry on the next turn.

### Timeout

If `cfg.timeoutMs` is set, `start()` schedules a `setTimeout`. On fire:

1. Run the canonical quiesce-and-publish flow with target phase
   `failed`, `failureReason = "TIMEOUT"`.
2. On abort timeout, snapshot stays `active`. Operator intervention
   required.

### Dispose

`dispose(lease?)` is idempotent abandonment:

1. Stop the wall-clock timer.
2. If phase is not `active`, return `Ok` (already disposed).
3. Run the canonical quiesce-and-publish flow with target phase
   `suspended`, `failureReason = "disposed"`.
4. If lease is omitted and phase is `active` and no in-memory lease
   exists for this harness, fail `STALE_REF` — caller must supply the
   lease for an active session it owns.

Repeated `dispose()` calls return `Ok` (phase short-circuit).

### Resume after crash

Crashed sessions leave the harness with `phase = "active"` and a
`SessionRecord` with `status = "running"`. The operator runs `koi resume
<sessionId>`. The package treats this as a normal `resume()` and
re-enters activation — there is no automatic crash detection inside the
package. The host (scheduler / daemon) is responsible for deciding when
to re-resume.

This is consistent with #1683's resume-from-cancel approach: durable
state is the snapshot chain + `lastEngineState`; the rest is
operational.

## Checkpoint Middleware

```ts
function createCheckpointMiddleware(
  harness: LongRunningHarness,
  cfg?: CheckpointMiddlewareConfig,
): KoiMiddleware;
```

Hooks:
- `afterTurn(ctx)`: if `shouldSoftCheckpoint(ctx, cfg)`, run soft
  checkpoint. Errors are logged via `ctx.logger`; do not propagate.
- `onError(err, ctx)`: if `err` is retryable, no-op. Otherwise, the
  engine will surface the error to the caller — no harness action.

## L0 Surface Used (verbatim — no migration required)

Reads only:
- `HarnessSnapshotStore.head(chainId)`
- `HarnessSnapshotStore.list(chainId)` for status/diagnostic only
- `SessionPersistence.loadSession(sid)`

Writes:
- `HarnessSnapshotStore.put(chainId, data, parentIds, metadata, opts)`
- `HarnessSnapshotStore.prune(chainId, policy)`
- `SessionPersistence.saveSession(record)`
- `SessionPersistence.setSessionStatus(sid, status)` —
  uses existing `running|idle|done`
- `SessionPersistence.removeSession(sid)` on activation rollback only

NO new fields, methods, error codes, or interfaces. Implementation
typechecks against today's `@koi/core` HEAD.

## Error Codes (existing only)

| KoiErrorCode | Used for |
|--------------|---------|
| `VALIDATION` | invalid config, illegal phase transition |
| `NOT_FOUND` | resume on non-existent harness |
| `CONFLICT` | start on already-active harness, concurrent activation race |
| `TIMEOUT` | abort timeout, wall-clock timeout |
| `STALE_REF` | revoked / superseded `SessionLease` |
| `EXTERNAL` | store I/O failure |
| `INTERNAL` | bug; should not be observed |

## Public Surface — Implementation Files

```
packages/sched/long-running/
  src/
    types.ts                    types + DEFAULT_LONG_RUNNING_CONFIG
    harness.ts                  createLongRunningHarness
    lease.ts                    SessionLease minting + WeakSet
    activation.ts               start / resume flow
    quiesce.ts                  quiesce-and-publish helper
    soft-checkpoint.ts          afterTurn helper
    checkpoint-middleware.ts    createCheckpointMiddleware
    checkpoint-policy.ts        shouldSoftCheckpoint, computeCheckpointId
    snapshot-builder.ts         build HarnessSnapshot from current state
    index.ts                    re-exports
  src/__tests__/
    activation.test.ts
    soft-checkpoint.test.ts
    quiesce.test.ts
    crash-recovery.test.ts
    middleware.test.ts
  package.json
  tsconfig.json
  README.md
docs/L2/long-running.md
```

Target LOC: ~700 (200 src files * 3-4 plus tests).

## Testing

Required regression tests (acceptance):
- Soft checkpoint cadence: turns 1-4 no checkpoint, turn 5 publishes.
- `pause()` quiesces engine, publishes `suspended`, releases lease.
- `pause()` with stale lease returns `STALE_REF`.
- `pause()` with engine that ignores abort returns `TIMEOUT`, snapshot
  stays `active`.
- `resume()` after pause loads `lastEngineState` if adapter supports
  `loadState`, falls back to transcript otherwise.
- Concurrent in-process `start()` calls: first wins, second
  `Err(CONFLICT)`.
- `completeTask` empties board → terminal flow → `phase=completed`.
- Retryable `failTask` keeps phase `active`, increments attempts.
- Timeout fires → `phase=failed`, `failureReason="TIMEOUT"`.
- `dispose()` is idempotent.
- Pruning policy applied after each terminal transition.

## Open Questions

None blocking. Implementation can begin against today's `@koi/core`.

## Risks

- **Forks in the chain on concurrent cross-process activation.** With
  no CAS, two processes both calling `resume(sid)` simultaneously would
  each `put` with the same parent and produce a fork. We rely on the
  host's process manager to serialize. Documented as a non-goal.
- **At-least-once side effects on crash recovery.** Documented; caller
  patterns are the mitigation.
- **`abort timeout` wedges in `phase=active`.** The package surfaces
  `Err(TIMEOUT)` and stops; operator intervention. There is no
  automatic background cleanup — by design (#1683 alignment).

## References

- Issue #1386 (this work)
- Issue #1683 (durable resume-from-cancel — sibling, no L0 changes)
- Issue #1217 (Phase 3 scheduler restoration — umbrella)
- v1 archive: `archive/v1/packages/sched/long-running/` (reference for
  task-board, summaries, artifact handling — patterns to port; v1's
  custom persistence is NOT ported)
