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
  readonly leaseTtlMs?: number;               // heartbeat staleness threshold; default 90_000
  readonly heartbeatIntervalMs?: number;      // how often the timer-driven loop bumps heartbeat; default 30_000
  readonly abortTimeoutMs?: number;           // max wait for engine to quiesce on durability loss; default 10_000
  // INVARIANT: abortTimeoutMs < leaseTtlMs - 2 * heartbeatIntervalMs
  // createLongRunningHarness throws INVALID_CONFIG if violated.
  readonly saveState?: SaveStateCallback;     // capture engine state on soft checkpoint
  readonly onCompleted?: OnCompletedCallback;
  readonly onFailed?: OnFailedCallback;
  readonly onDurabilityLost?: (err: KoiError) => void | Promise<void>;
}
```

`leaseTtlMs` MUST be >= 3× `heartbeatIntervalMs` to tolerate transient pauses
without false reclamation. Defaults satisfy this (90s vs. 30s).

### `LongRunningHarness`

```ts
/**
 * Opaque ownership capability for the currently-active session.
 *
 * A SessionLease is a runtime-identified object. The harness maintains a
 * WeakSet of leases it has minted; validation checks object identity against
 * that set, not structural shape. TypeScript branding is documentation only —
 * the real capability boundary is runtime identity.
 *
 * The only callable surface on the lease itself is `abort()` (attached to an
 * internal AbortController). `sessionId` and `generation` are exposed for
 * debugging/logging only; mutation APIs ignore these fields and check the
 * WeakSet.
 */
interface SessionLease {
  readonly abort: AbortSignal;     // fires when the lease is revoked
  readonly sessionId: string;      // read-only, debugging/logging
  readonly generation: number;     // read-only, debugging/logging
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
  /**
   * Abort the active run. Exposed so durability-loss handlers (inside
   * checkpoint middleware) can force engine quiescence before releasing the
   * lease. Returns once the engine adapter has stopped emitting events or
   * abortTimeoutMs has elapsed.
   */
  readonly abortActive: (reason: KoiError) => Promise<Result<void, KoiError>>;
  readonly status: () => HarnessStatus;
  readonly createMiddleware: (lease: SessionLease) => KoiMiddleware;
  readonly dispose: () => Promise<Result<void, KoiError>>;
}
```

```ts
interface StartResult {
  readonly lease: SessionLease;
  readonly engineInput: EngineInput;
  readonly sessionId: string;
  /**
   * Non-fatal warning observed during activation. When present, the `active`
   * snapshot was published and the lease is valid, but a secondary write
   * (e.g. setSessionStatus) failed. Reclamation remains safe; the caller
   * should log the warning and may proceed or relinquish.
   */
  readonly activationWarning?: KoiError;
}

interface ResumeResult extends StartResult {
  readonly engineStateRecovered: boolean;
}
```

`StartResult` and `ResumeResult` both carry a fresh `SessionLease`. Callers
pass it back on every mutating call; the harness validates:

1. `activeLeases.has(lease) === true` — WeakSet membership test. The harness
   constructs every lease via a private factory and inserts it into a
   `WeakSet<SessionLease>`. A forged object (even one with correct
   `sessionId`/`generation`/`abort` fields) is not in the set and is rejected.
2. `lease === currentLease` — identity equality against the single in-memory
   reference the harness considers authoritative.

Any failure → `KoiError { code: "STALE_SESSION", retryable: false }`.

Revocation (on timeout, durability loss, supersession, or dispose):

- Remove from `activeLeases`.
- Fire `lease.abort` via the internal controller.
- Any subsequent mutating call holding the old reference fails identity
  check immediately.

Because leases are checked by runtime identity (not structural fields), a
caller that reads the snapshot store and learns `lastSessionId`/`generation`
cannot construct a valid lease. This is the runtime capability boundary; the
TypeScript type is documentation only.

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

### Resume — Exclusive Lease Protocol with Crash Reclamation

Concurrent resume attempts must not both produce an active session. Crashed or
abandoned `active` snapshots must be reclaimable, not permanently stuck. The
protocol combines CAS fencing with startup reconciliation against
`SessionPersistence`.

**Activation ordering (crash-safe):** every state-advancing operation follows
session-first, then snapshot. On `start()` / successful `resume()`:

1. Write a session record with `status = "starting"` AND
   `lastHeartbeatAt = Date.now()` via `sessionPersistence.saveSession`
   **before** any harness snapshot advance.
   If this fails → abort with `CHECKPOINT_WRITE_FAILED`; harness head is
   unchanged, no orphan is possible.
2. Start the heartbeat loop immediately so `lastHeartbeatAt` stays fresh
   through every subsequent step.
3. Mint the `SessionLease` and add it to `activeLeases` WeakSet (but do NOT
   return it to the caller yet — still inside activation).
4. CAS-advance harness snapshot to `active` with the new generation,
   `lastSessionId` pointing at the record from step 1, and
   `activatedAt = Date.now()`. If CAS fails → rollback: remove lease from
   WeakSet, stop heartbeats, best-effort `removeSession(sid)`, return
   `CONCURRENT_RESUME`. Any durable orphan is cleaned by reconciliation.
5. Attempt `sessionPersistence.setSessionStatus(sid, "running")`.
   Regardless of outcome, the harness snapshot is already `active`, the
   heartbeat is running, and the lease is minted. We MUST always return
   the lease so the caller can eventually relinquish.
   - **On success:** return `Ok(StartResult { lease, engineInput,
     sessionId, activationWarning: undefined })`.
   - **On failure:** return
     `Ok(StartResult { lease, engineInput, sessionId, activationWarning:
     KoiError { code: "ACTIVATION_STATUS_WRITE_FAILED", retryable: true } })`.
     The return is `Ok` (not `Err`) because the caller has a valid lease
     and can proceed; the warning is a field on the result. The caller
     MUST check `activationWarning` and decide whether to proceed (TTL
     keeps reclaim safety since `"starting"` is treated identically to
     `"running"` via heartbeat TTL) or to call `pause(lease, …)` /
     `fail(lease, …)` to cleanly relinquish.

This encoding fits the repo's strict `Result<T, E>` union: success returns
the fully-usable state plus an optional warning; errors are reserved for
cases where no lease is handed back. The activation contract guarantees:
**once the `active` snapshot is published, the caller always receives
a valid lease in an `Ok` result.**

A crash between (1) and (4) leaves an orphan session record with no pointer
from the harness — harmless, pruned by reconciliation (below). A crash
between (4) and (5) leaves an `active` harness pointing at a `"starting"`
session record — NOT immediately reclaimable because reclaim uses TTL,
not status.

**Resume flow:**

1. Read `harnessStore.latest()` → `prev: HarnessSnapshot | undefined`.
   - Undefined → `KoiError { code: "NOT_FOUND" }` (unless called via `start`).
   - `prev.phase ∈ { completed, failed }` → `KoiError { code: "TERMINAL" }`.
   - `prev.phase === "suspended"` → proceed to activation (normal resume).
   - `prev.phase === "active"` → run **reclamation check** (below). If the
     active owner is live, reject `ALREADY_ACTIVE` (retryable). If dead,
     fence-and-reclaim.
2. Run activation ordering above, using `prev.chainHead` as the CAS expected
   value.
3. If CAS fails (peer raced us) → `KoiError { code: "CONCURRENT_RESUME", retryable: true }`;
   roll back the orphan session record written in step 1 via `removeSession`
   (best-effort; reconciliation sweeps any survivors).

**Reclamation check for `active` snapshots:**

Given `prev.phase === "active"` and `prev.lastSessionId = sid`:

1. `sessionPersistence.loadSession(sid)` → `record: SessionRecord | NOT_FOUND`.
2. Decide the owner's liveness. **TTL staleness is the ONLY primary
   dead-owner signal** — status flags are advisory. This avoids relying on
   cross-store read-after-write consistency between `harnessStore` and
   `sessionPersistence`, which L0 does not guarantee:
   - `NOT_FOUND` → session-record read lagging behind the snapshot write
     is indistinguishable from "owner never wrote"; treat as **unknown**
     until the harness-snapshot's `activatedAt` is older than `leaseTtlMs`.
     - `now - snapshot.checkpointedAt > leaseTtlMs` → reclaimable (the
       owner has had ample time to publish a session record; if the store
       still can't read it after TTL, the owner is not producing
       observable liveness).
     - Otherwise → `ALREADY_ACTIVE` (retryable).
   - `record.status === "done"` → advisory signal of clean exit, but still
     require TTL-stale heartbeat before reclaim (protects against lagged
     reads of an old status).
   - `record.status === "idle"` → same: advisory, require TTL-stale
     heartbeat.
   - `record.status === "abandoned"` → immediately reclaimable, no TTL
     wait required. The tombstone is only written by the lease holder
     after confirmed engine quiescence, so it proves the run has stopped
     even when the snapshot store is not yet consistent.
   - `record.status ∈ { "starting", "running" }` — apply TTL rule:
     - `now - record.lastHeartbeatAt > leaseTtlMs` → **dead**. Reclaim.
     - Heartbeat fresh → **live**. `ALREADY_ACTIVE`.

Unified rule: **reclaim only when at least one independent timestamp
(heartbeat OR snapshot `activatedAt`/`checkpointedAt`) proves inactivity
beyond `leaseTtlMs`.** Status flags accelerate recognition of genuinely
dead owners but never override TTL for liveness decisions, because status
reads may cross a lagging durability boundary.

`"starting"` is informational only. A live owner mid-activation heartbeats
(loop started in activation step 2) and holds the lease; a crashed
mid-activation owner goes stale within TTL. This closes both the
activation-latency race and the cross-store-lag race.
3. To reclaim: CAS-advance `prev` → `next` with
   `phase = "suspended"`, `generation = prev.generation + 1`,
   `failureReason = "RECLAIMED_FROM_DEAD_OWNER"`. This fences the dead owner's
   lease. Then re-enter the resume flow from step 1 with the now-suspended
   snapshot.

**Heartbeat loop (mandatory, timer-driven).**

The harness runs an independent heartbeat loop from `start()`/`resume()` until
`pause()`/`fail()`/`dispose()`. It is NOT tied to turn boundaries.

- On activation: `setInterval(bumpHeartbeat, heartbeatIntervalMs)`.
- `bumpHeartbeat` calls `sessionPersistence.setHeartbeat(sessionId, Date.now())`
  (new L0 method, see prerequisites).
- **Heartbeat-write failure is not a log-and-retry.** The harness tracks
  `lastPersistedHeartbeatAt` (the timestamp of the last *successful* write).
  Before every tick, it computes `remaining = leaseTtlMs - (now - lastPersistedHeartbeatAt)`.
  - If `remaining < heartbeatIntervalMs * 2` (approaching staleness) AND the
    most recent write failed: **invoke `abortActive("HEARTBEAT_STALE")`
    immediately**. This forces engine quiescence before TTL expires and
    another process can legitimately reclaim.
  - `onDurabilityLost` is invoked on the first failed write, not after
    contiguous failures.
- Lease validation (before every mutating store write) refreshes the
  heartbeat before the CAS. If that heartbeat write fails, the mutation is
  rejected with `CHECKPOINT_WRITE_FAILED` and `abortActive` is invoked.
- A long turn (minutes or hours, no checkpoint, no tool return) continues to
  heartbeat on the timer and is never falsely reclaimed while writes succeed.
  If writes fail, the run proactively stops itself before the reclamation
  window opens.

Invariant: `(now - lastPersistedHeartbeatAt) < leaseTtlMs` OR the engine has
been signalled to abort. There is no window where a live run both fails to
persist heartbeats AND remains non-abortable. The heartbeat loop is the
authoritative liveness signal; turn-boundary writes bump it opportunistically
as a latency optimization, never as the sole signal.

**Start:**

`start()` is `resume()` with `prev === undefined` as precondition. CAS tolerates
absence → initial snapshot. If `prev` exists and is not terminal, `start()`
rejects with `INVALID_STATE` (caller should use `resume`).

**Lease enforcement on mutating calls:**

All mutating calls (`pause`, `fail`, `completeTask`, `failTask`, checkpoint
middleware writes) take the `SessionLease` as an explicit argument. Before every
store write, the harness asserts `lease.generation === currentSnapshot.generation`.
Stale leases (timed-out sessions, superseded runs, reclaimed runs) are rejected
with `KoiError { code: "STALE_SESSION", retryable: false }` and their writes
are never persisted.

**L0 prerequisites (required, additive):**

1. `HarnessSnapshot.generation: number` — monotonic per harness.
2. `SnapshotChainStore.compareAndPut(expectedHead, next)` — CAS advance.
3. `SessionRecord.lastHeartbeatAt: number | undefined` — liveness signal.
4. `SessionStatus` adds `"starting"` between `idle` and `running`.

These must land in a prerequisite L0 PR before the L2 package ships.

### Progress Tracking

Derived from `HarnessStatus`, not stored separately:

- `taskBoard.tasks` provides completed/pending counts.
- `metrics.totalTurns`, `metrics.completedTaskCount` accumulate across sessions.
- `status()` is pure — safe to call at any time from any caller.

### Timeout — Quiesce Before Terminalize

A timed-out run must not have its terminal snapshot published while the
engine is still producing side effects. `failed` is an observable terminal
state that external schedulers rely on; declaring it prematurely lets
post-timeout writes leak out as "ghost" activity after the system has
reported the run complete.

Flow:

1. `setTimeout` fires at `timeoutMs`.
2. Revoke the lease (remove from `activeLeases`, fire `lease.abort`).
   Subsequent harness API calls from the aborted run fail identity check.
3. Wait up to `abortTimeoutMs` for the engine adapter to quiesce.
4. **On quiescence:** CAS-advance to `failed` with
   `failureReason = "TIMEOUT"`. Invoke `onFailed` with the final status.
5. **On abort timeout (engine refuses to stop):** do NOT advance to
   `failed`. Keep the snapshot `active`, keep heartbeats running so the
   session is NOT reclaimable, and raise a loud escalation:
   `status().durability = "unhealthy"`, `status().failureReason =
   "TIMEOUT_NOT_QUIESCED"`, invoke `onDurabilityLost` with
   `KoiError { code: "ABORT_TIMEOUT", retryable: false }`. The host MUST
   escalate (SIGKILL the process, operator intervention) before the run
   can be cleared. No reclaimer runs in parallel with the ignored run.

The TS `failed` phase remains a strong signal: "engine has stopped,
scheduler may now act terminally." If the engine cannot be stopped, we
loudly refuse to lie about it.

### Cleanup on Abandonment

`dispose()` is idempotent and follows the quiesce-before-publish rule. It
MUST NOT publish a `suspended` snapshot while the engine is still producing
side effects — that would let a replacement process resume in parallel with
the original run.

Unambiguous algorithm:

1. Stop ONLY the wall-clock timeout timer (`clearTimeout(timeoutHandle)`).
   **Do NOT stop the heartbeat timer.** Heartbeats must continue.
2. If phase is not `active`, return `Ok(undefined)` — nothing further.
3. Revoke the lease (remove from `activeLeases`, fire `lease.abort`).
   In-process callers with the old reference now fail identity check.
4. Signal the engine adapter to stop, then `await quiesce(abortTimeoutMs)`.
5. Throughout step 4, the heartbeat loop continues unchanged. Config
   invariant `abortTimeoutMs < leaseTtlMs - 2 * heartbeatIntervalMs`
   guarantees at least one heartbeat will succeed during the quiesce
   window even if one misses.
6. Branch on the quiesce outcome:
   - **Quiescent:** THIS is the first place the heartbeat loop is stopped.
     Then CAS-advance to `suspended` with
     `failureReason = "disposed before completion"`. Best-effort snapshot
     write — if it fails, heartbeat-staleness will reclaim (safe now
     because the engine is confirmed stopped). Release store references.
     Return `Ok(undefined)`.
   - **Timed out (engine ignored abort):** do NOT publish `suspended`.
     Do NOT stop the heartbeat loop. The heartbeat loop is detached from
     `dispose`'s lifetime and retained by the process until either (a)
     the engine eventually stops and a separate `dispose` round finishes
     cleanup, or (b) process exit releases all resources. Lease remains
     live from the store's perspective (session status unchanged,
     heartbeat fresh). Flip `status().durability` to `"unhealthy"`,
     invoke `onDurabilityLost(KoiError { code: "ABORT_TIMEOUT" })`, and
     return `Err(ABORT_TIMEOUT)`. The host is expected to SIGKILL.

Invariant checklist an implementer MUST verify:
- No code path between `start/resume` and `dispose` quiesce success stops
  the heartbeat timer. (Audit: heartbeat stop appears only inside the
  quiescent branch of step 6 and inside `pause`/`fail` after their own
  quiesce waits.)
- No path publishes `suspended` before engine quiescence is confirmed.
- No path publishes `failed` before engine quiescence is confirmed.

**Invariant (spec-enforced):** `abortTimeoutMs < leaseTtlMs - 2 *
heartbeatIntervalMs`. The config constructor validates this at
`createLongRunningHarness(cfg)` time and returns
`KoiError { code: "INVALID_CONFIG" }` if violated. This guarantees the
quiesce wait cannot outlive the TTL window even if heartbeats were to
stall — an additional defense beyond "don't stop heartbeats early".

Default config satisfies the invariant: `abortTimeoutMs=10_000`,
`heartbeatIntervalMs=30_000`, `leaseTtlMs=90_000` →
`10_000 < 90_000 - 60_000 = 30_000`. ✓

No process-level cleanup (kill subprocess, close sockets) — that's `@koi/daemon`.
But no safety rule is softened: dispose never advertises a resumable state
while execution is ongoing.

### Checkpoint Middleware

```ts
createCheckpointMiddleware({
  harness,
  lease,                              // SessionLease for the current run
  onDurabilityLost,                   // required — host escalation callback
  policy?,
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
   `unhealthy` (`status().durability = "lost"`). Fail the turn with
   `KoiError { code: "CHECKPOINT_WRITE_FAILED", retryable: true }` and invoke
   `onDurabilityLost`. Proceed with the Degraded-durability recovery path
   below — execution is stopped before the lease is released, so no
   split-brain is possible.

**Degraded-durability recovery path.** On I/O failure, the authoritative
store still points at the previous `active` snapshot. Recovery must preserve
exclusivity: we cannot simultaneously advertise the session as reclaimable AND
keep executing, or a competing `resume()` will fence-and-replace while the
original run is still issuing side effects (split-brain).

Therefore the default path is:

1. Fail the current turn with `CHECKPOINT_WRITE_FAILED`.
2. Invoke `onDurabilityLost` for host escalation.
3. **Stop engine execution before giving up the lease.** The middleware calls
   `harness.abortActive(...)`, which revokes the lease, fires the abort
   signal, and waits up to `abortTimeoutMs` for the engine to quiesce.
4. Once quiesced, **attempt immediate fencing so recovery does not wait for
   TTL**. This is critical: merely stopping heartbeats and marking the
   session `idle` leaves the authoritative snapshot as `active`, and
   reclaim rules require TTL staleness — so a single transient I/O fault
   could block failover for up to `leaseTtlMs`. We fence via two
   independent attempts, either of which makes the harness immediately
   reclaimable:
   - **Attempt A: retry the snapshot store.** I/O failures are often
     transient; the initial `compareAndPut` is retried with exponential
     backoff (default 3 tries, 100/500/2500ms). On success, advance to
     `suspended` with `failureReason = "CHECKPOINT_WRITE_FAILED"` and a
     new generation. The harness is now `suspended`; any `resume()`
     proceeds immediately with no TTL wait.
   - **Attempt B: write a tombstone to session persistence.** Regardless
     of attempt A's outcome, mark the session with a new
     `"abandoned"` status via `setSessionStatus(sid, "abandoned")`.
     This is a different store from `harnessStore` and may be healthy
     even when the snapshot store is not. Reclaim is extended to treat
     `active + session.status === "abandoned"` AS IMMEDIATELY
     RECLAIMABLE (no TTL wait required). The tombstone is
     cryptographically meaningful because only the current lease
     holder can write it after quiescence — cross-store lag only
     delays observation, never creates a false positive.
5. After step 4, stop the heartbeat loop. Whichever of A or B succeeded
   makes the harness reclaimable within a heartbeat round-trip, not a TTL.
   If BOTH A and B fail, fall back to TTL-based reclaim — no worse than
   the prior design.
6. If `abortActive` times out (engine refuses to stop): keep heartbeating,
   keep session `"running"`, flip `durability` to `"unhealthy"`, return
   `Err(ABORT_TIMEOUT)` from the middleware path, loud escalation via
   `onDurabilityLost`. Host must SIGKILL to release the lease.

`continueWithoutDurability` is **removed**. Allowing continued execution while
marking the session reclaimable was a split-brain vector: it let a second
process legitimately claim the lease and execute non-idempotent work in
parallel with the original run. If an operator truly needs in-memory-only
continuation, they can catch `CHECKPOINT_WRITE_FAILED` in their host code,
but the harness will not unilaterally downgrade exclusivity.

Invariant: **the lease (session status + heartbeat freshness) accurately
reflects whether execution is ongoing.** A run that is still executing cannot
appear reclaimable; a run that has stopped executing becomes reclaimable
within `leaseTtlMs` via one of two independent signals.

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
- `dispose()` on an active harness revokes the lease, aborts the engine,
  and only publishes `suspended` after quiescence.
- `dispose()` returns `Promise<Result<void, KoiError>>`. Ok path on
  quiescence; `Err(ABORT_TIMEOUT)` when engine refuses to stop. Host keys
  SIGKILL decisions off this typed result.
- `dispose()` on an active harness whose engine refuses to quiesce returns
  `Err(ABORT_TIMEOUT)`, does NOT publish `suspended`, and KEEPS heartbeats
  running so no reclaimer can race the still-executing engine. Host must
  SIGKILL to release the lease.
- `dispose()` with a running engine and an `abortTimeoutMs` that violates
  the invariant is rejected at `createLongRunningHarness` time with
  `INVALID_CONFIG`, not at dispose time.
- `status().durability` reflects `"unhealthy"` after ABORT_TIMEOUT or
  sustained heartbeat-write failure; host automation can observe it via
  `status()` without waiting for the dispose result.
- `timeout` on an active harness whose engine refuses to quiesce does NOT
  publish `failed`, keeps snapshot `active` + heartbeats live, invokes
  `onDurabilityLost(ABORT_TIMEOUT)`. External schedulers see the run is
  still active; no "ghost" post-terminal side effects are possible.
- `dispose()` is idempotent across repeated calls.
- `status()` returns current state without mutation.

### Unit: `checkpoint-middleware.test.ts`

- Fires soft checkpoint every `softCheckpointInterval` turns.
- CAS success advances head; subsequent soft checkpoint uses new head.
- Store I/O failure fails the turn with `CHECKPOINT_WRITE_FAILED`, invokes
  `onDurabilityLost`, aborts the engine via lease signal, stops heartbeats,
  marks session `idle`. No silent degradation. No continue-with-in-memory
  escape hatch.
- Engine refuses to abort within `abortTimeoutMs` → heartbeats continue and
  session remains `running`; `onDurabilityLost` surfaced — host must SIGKILL.
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

### Unit: crash recovery (`harness.test.ts`)

- **Crash mid-activation, heartbeat stale:** snapshot=`active` + session
  record=`"starting"` + `lastHeartbeatAt < now - leaseTtlMs`. Second process
  calls `resume()` → reclamation detects dead owner via TTL staleness
  (not `"starting"` alone) → fences + reclaims.
- **Crash mid-run with stale heartbeat:** snapshot=`active` + session record
  `status="running"`, `lastHeartbeatAt < now - leaseTtlMs`. `resume()` reclaims.
- **Live owner blocks reclaim:** snapshot=`active` + fresh heartbeat →
  `resume()` returns `ALREADY_ACTIVE`.
- **Orphan session record after partial activation:** session written but CAS
  failed. Next `resume()` ignores orphan (no pointer from harness); periodic
  reconciliation (`pruneOrphanSessions`) removes it.
- **Durability loss mid-run with transient fault:** I/O failure on soft
  checkpoint → middleware aborts engine → after quiescence, snapshot-store
  retry with backoff succeeds → `suspended` snapshot published →
  immediate `resume()` proceeds without TTL wait.
- **Durability loss mid-run with persistent fault:** snapshot-store retries
  all fail → `setSessionStatus("abandoned")` succeeds (different store) →
  immediate `resume()` reclaims via abandoned-status path, no TTL wait.
- **Durability loss mid-run, both stores unhealthy:** both snapshot-store
  retry AND abandoned tombstone fail → heartbeat loop stopped → reclaim
  via TTL staleness after `leaseTtlMs`. (Regression: spec never makes
  recovery worse than TTL wait.)
- **Long-turn heartbeat:** a single turn that exceeds `leaseTtlMs` without
  reaching a checkpoint boundary continues to heartbeat via the timer loop;
  a concurrent `resume()` attempt returns `ALREADY_ACTIVE`, not a successful
  reclamation. (Regression test for false dead-owner reclamation.)
- **Heartbeat-write failure proactive abort:** simulated `setHeartbeat` I/O
  failure with `lastPersistedHeartbeatAt` approaching TTL → harness invokes
  `abortActive` before TTL expires → no competing `resume()` can reclaim
  while execution is still ongoing.
- **Heartbeat loop lifecycle:** heartbeat starts on `start()`/`resume()` and
  stops on `pause()`/`fail()`/`dispose()`; no heartbeats emitted outside
  active phase.
- **Lease forgery rejection (runtime):** a structurally-identical object
  constructed outside the harness (same `sessionId`, `generation`, and a
  caller-provided `AbortSignal`) is rejected because it is not in the
  `activeLeases` WeakSet. Runtime identity check is the real capability
  boundary, not the TS type.
- **Mid-activation reclaim blocked:** inject artificial delay between
  `active`-snapshot publish and `"running"` status flip. A concurrent
  `resume()` observing `"starting"` status during this window must return
  `ALREADY_ACTIVE` (heartbeat fresh), NOT reclaim.
- **abortActive contract:** invoking `abortActive` revokes the lease,
  propagates via `lease.abort`, waits up to `abortTimeoutMs`, returns
  `Ok` on quiescence or `KoiError { code: "ABORT_TIMEOUT" }` otherwise. A
  subsequent mutation on the revoked lease is rejected before any store write.
- **No reclaim while engine is running (adversarial):** fake engine that
  ignores `AbortSignal` keeps emitting events. Timeout fires → abort times
  out → snapshot stays `active`, heartbeats continue → concurrent
  `resume()` returns `ALREADY_ACTIVE` indefinitely until the fake engine
  stops or the process is killed. No post-terminal side effects observed.
- **Activation rollback:** session `saveSession` succeeds but CAS fails →
  orphan session is cleaned via `removeSession` best-effort; harness head
  unchanged; heartbeat loop stopped; lease removed from WeakSet.
- **Activation status-write failure (post-publish):** `saveSession` ok, CAS
  ok, but `setSessionStatus("running")` fails. Caller receives a valid
  lease AND `ACTIVATION_STATUS_WRITE_FAILED`. Proceeding with the lease
  succeeds (heartbeats keep it live); explicit `pause(lease, ...)`
  cleanly transitions to `suspended`. A concurrent `resume()` sees TTL-fresh
  heartbeat and returns `ALREADY_ACTIVE`, not reclaim.
- **Cross-store lag (reclaim safety):** simulated `sessionPersistence` that
  returns `NOT_FOUND` for a freshly-written session record while the
  snapshot store already shows `active`. Reclamation does NOT treat this
  as dead-owner; it returns `ALREADY_ACTIVE` until `activatedAt` exceeds
  TTL. (Regression against cross-store split-brain.)

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
| `STALE_SESSION` | mutating call presented a revoked/superseded/tampered lease | false |
| `CHECKPOINT_WRITE_FAILED` | store `put`/`compareAndPut`/`setHeartbeat` rejected (I/O) | true |
| `HEARTBEAT_STALE` | heartbeat persistence approaching TTL with recent failure | false |
| `ABORT_TIMEOUT` | engine did not quiesce within `abortTimeoutMs` | false |
| `INVALID_CONFIG` | `abortTimeoutMs >= leaseTtlMs - 2*heartbeatIntervalMs` | false |
| `ACTIVATION_STATUS_WRITE_FAILED` | step-5 `setSessionStatus("running")` write failed; returned via `StartResult.activationWarning`, NOT via `Err`; lease is still valid | true |
| `RESUME_CORRUPT` | snapshot fails `isHarnessSnapshot` | false |

## References

- v1 archive: `archive/v1/packages/sched/long-running/` — blueprint for the runtime
  (28K LOC; we port only the harness + checkpoint subset, ~500 LOC).
- L0 contract: `packages/kernel/core/src/harness.ts`, `session.ts`, `snapshot-chain.ts`.
- Claude Code: `src/tasks/LocalMainSessionTask.ts` — validates the
  background/resume/notify UX pattern (single-process analogue).

## L0 Prerequisites

This design requires four additive changes to `@koi/core` / `@koi/session` L0
types before the L2 package can be implemented:

1. `HarnessSnapshot.generation: number` — monotonic per harness, incremented on
   every session transition. Drives lease fencing. Plus
   `HarnessSnapshot.activatedAt: number | undefined` — activation wall-clock
   time used as the fallback liveness signal when session-record reads
   lag across stores.
2. `SnapshotChainStore.compareAndPut(expectedHead, next)` — CAS-conditioned
   advance. Existing `put` is insufficient for exclusivity guarantees.
3. `SessionRecord.lastHeartbeatAt: number | undefined` — liveness signal for
   crash reclamation.
4. `SessionStatus` gains `"starting"` between `idle` and `running` plus
   `"abandoned"` as a terminal tombstone that makes the harness
   immediately reclaimable without waiting for heartbeat TTL.
5. `SessionPersistence.setHeartbeat(sessionId, timestampMs)` — dedicated
   cheap-write method so the heartbeat loop does not compete with full
   `saveSession` writes.
6. `HarnessStatus.durability: "ok" | "unhealthy"` — observable degraded-state
   signal. Hosts key automation (pager, SIGKILL escalation) off this field.
   Default `"ok"`; flips to `"unhealthy"` on `ABORT_TIMEOUT` or sustained
   heartbeat-write failure. Transitions back to `"ok"` only on a clean
   `start()`/`resume()` with a fresh session.

All four are backward-compatible and should land in a prerequisite L0 PR.

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
