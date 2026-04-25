# `@koi/long-running` — Agent Checkpointing (Issue #1386)

**Status:** Design — BLOCKED on L0 migration (see L0 Prerequisites
section). Not ready for implementation until all prereq PRs land and
pass contract tests.
**Issue:** [#1386](https://github.com/windoliver/koi/issues/1386) — v2 Phase 3-sched-2: long-running agent checkpointing
**Scope estimate:** ~500 LOC
**Layer:** L2 (feature package)

## Purpose

Enable Koi agents to run over hours or days across many sessions. Provide atomic
checkpoint/resume, progress tracking, timeout enforcement, and abandonment cleanup
for long-running harnesses.

## Scope of the Correctness Guarantee

**This package guarantees exclusivity of durable state transitions.** At most
one `SessionLease` is valid at a time; all mutating harness operations (pause,
fail, complete/fail-task, checkpoint writes, dispose) are lease-fenced and use
CAS against `SnapshotChainStore`. Under a cooperating supervisor, cross-process
fencing adds `killAndConfirm` before reclaim. Under these conditions, **durable
harness state is exactly-once**: a reclaimer cannot advance state from a stale
view, and a terminalized run cannot be revived.

**This package does NOT guarantee exactly-once external side effects.** Tools
that write to external systems (HTTP POST, DB mutations, outbound messages,
file writes outside the harness store) can be replayed across reclaim because:

- A worker may emit a side effect AFTER its last durable checkpoint but
  BEFORE `killAndConfirm` completes. The replacement session resumes from the
  pre-side-effect snapshot and may re-execute that work.
- Lease revocation fires `AbortSignal` cooperatively; tools that ignore the
  signal continue emitting until SIGKILL.

**Callers requiring exactly-once external effects MUST use one of:**
1. **Idempotent tool invocations** keyed by `(harnessId, generation, toolCallId)`.
2. **Transactional outbox pattern** where side effects are queued into the
   harness state first, then published by a separate idempotent worker.
3. **Tool-layer epoch check:** long-running tools accept the current
   `lease.generation` and reject calls whose generation is no longer the
   current snapshot's. See the Exclusivity Model section — this is a
   downstream convention, not a package contract.

The package contract is scoped accordingly: **exactly-once durable harness
transitions; at-least-once external side effects unless caller adopts one of
the three patterns above.** Issues expecting stronger guarantees must either
land a separate L2 package (outbox, epoch-fencing middleware) or narrow
their scope.

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

## Exclusivity Model and Supervisor Requirement

**This package provides in-process exclusivity. Cross-process exclusivity
requires a cooperating supervisor.**

Lease identity, CAS fencing, and heartbeat TTL protect against every
scenario where the old engine cooperates with its `AbortSignal`: clean
shutdowns, timeouts, durability losses, and crashes. They CANNOT stop a
stalled-but-alive process (host sleep, VM suspension, long GC pause) from
waking up and continuing to emit side effects after a peer has
legitimately reclaimed via TTL staleness.

To close that gap, this package MUST run under a supervisor that provides
**kill-on-takeover** semantics:

- Before any peer reclaims a harness via TTL staleness, the supervisor
  MUST terminate the prior worker process with SIGKILL (or equivalent OS
  primitive). This is the only mechanism that can interrupt already-
  running tool side effects in a non-cooperative fashion.
- The supervisor owns process lifecycle; the harness owns durable state.
- `@koi/daemon` is the intended supervisor in v2; any equivalent
  (kubectl, launchd, systemd, PID-file-based orchestrator) is acceptable
  as long as it enforces kill-on-takeover.

**The harness makes the supervisor requirement enforceable via an explicit
`Supervisor` config interface:**

```ts
interface Supervisor {
  /**
   * Non-destructive liveness probe. Returns the worker's current state
   * without affecting it. Implementations:
   *  - @koi/daemon: kill -0 on the PID; check process table.
   *  - kubectl: read pod.status.phase.
   *  - launchd/systemd: query unit ActiveState.
   *
   * "alive"  — worker is running.
   * "dead"   — worker is confirmed exited / not in process table.
   * "unknown" — supervisor cannot determine state right now (transient
   *             query failure). Caller must NOT treat as dead.
   */
  readonly probeAlive: (sessionId: string) =>
    Promise<Result<"alive" | "dead" | "unknown", KoiError>>;

  /**
   * Forcibly terminate the worker that owns the given session and return
   * only after termination is confirmed. Implementations:
   *  - @koi/daemon: SIGKILL the worker PID, await its exit code.
   *  - kubectl: delete the pod, await pod phase === "Failed".
   *  - launchd/systemd: stop the unit, await inactive.
   *
   * Idempotent: on an already-dead worker returns Ok.
   * Returns Err(KILL_FAILED) only if the supervisor itself is unhealthy.
   */
  readonly killAndConfirm: (sessionId: string) =>
    Promise<Result<void, KoiError>>;
}
```

**Reclaim probe-then-kill protocol.** Before any reclaim path issues a
destructive `killAndConfirm`, it MUST first call `probeAlive`:
- `probeAlive === "alive"` → return `Err(RECLAIM_LIVE_OWNER, retryable: true)`
  WITHOUT killing. The owner is healthy; this is a read-path fault on
  `loadSession`, not a dead owner.
- `probeAlive === "dead"` → proceed to `killAndConfirm` (idempotent
  no-op) then CAS-advance.
- `probeAlive === "unknown"` AND heartbeat-stale signal also present
  AND sustained (re-probe after `heartbeatIntervalMs * 2` still
  "unknown") → escalate to `killAndConfirm`. This pairs the
  destructive action with multiple independent dead-owner signals.
- `probeAlive` returns `Err(IO_ERROR)` → return
  `Err(SUPERVISOR_UNHEALTHY, retryable: true)`. Never kill on a
  failed probe.

`LongRunningConfig` accepts `supervisor?: Supervisor`. The reclaim path is
gated on its presence:

- If `config.supervisor` is defined: reclaim invokes
  `supervisor.killAndConfirm(prev.lastSessionId)` BEFORE the CAS advance
  to `suspended`. A kill failure aborts reclaim with
  `KoiError { code: "KILL_FAILED", retryable: true }`; the CAS is not
  attempted.
- If `config.supervisor` is absent AND `config.trustedSingleProcess !==
  true`: `createLongRunningHarness` returns
  `KoiError { code: "INVALID_CONFIG", message: "either supervisor or
  trustedSingleProcess must be set" }`.
- If `config.trustedSingleProcess === true`: the harness refuses to
  reclaim any `active` snapshot on `resume()` — it returns
  `ALREADY_ACTIVE` unconditionally for non-terminal phases and requires
  explicit operator action to relinquish. Sacrifices availability for
  correctness in environments without a supervisor.

The same supervisor contract gates orphan-record recovery: CAS-advancing
to `suspended` (NOT terminal) with `ORPHAN_RECOVERED` also requires a
successful `killAndConfirm` first. If the supervisor reports the
session's worker is alive, the harness returns `RECLAIM_LIVE_OWNER`
(retryable) and the caller investigates. See Reclamation check for the
full protocol.

**Tool-layer epoch check (optional, recommended for non-idempotent
tools):** long-running tools that perform external side effects (HTTP
POST, DB writes, outbound messages) SHOULD accept the current
`lease.generation` at invocation time and reject calls whose generation
is no longer the current snapshot's. This is a defense-in-depth
mechanism; it does not replace the supervisor requirement but reduces
the blast radius of a stalled-but-waking process that has not yet been
SIGKILLed. The tool-epoch check is NOT part of this package's 500-LOC
scope; it is a downstream convention enforced by tool authors.

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

- **Depends on:** `@koi/core` (L0) only, BUT requires a coordinated
  breaking L0 migration to land first (see L0 Prerequisites). Current
  main does not expose the L0 surface this design needs —
  `SnapshotChainStore` has no `compareAndPut`/`latest`; `SessionStatus`
  is `running|idle|done`; `HarnessSnapshot` has no `generation`;
  `HarnessStatus` has no `durability`; `SessionPersistence` has no
  heartbeat or terminal-outcome methods. Implementation is blocked on
  those prereqs.
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

  /**
   * Supervisor with killAndConfirm. Required unless trustedSingleProcess
   * is true. See "Exclusivity Model and Supervisor Requirement".
   */
  readonly supervisor?: Supervisor;
  /**
   * When true, the harness refuses to reclaim any `active` snapshot on
   * resume(). Required iff supervisor is not provided.
   */
  readonly trustedSingleProcess?: boolean;
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
   * Abort the active run. Requires the current SessionLease — enforces
   * the same capability boundary as other mutating methods. Exposed so
   * durability-loss handlers inside checkpoint middleware can force
   * engine quiescence before releasing the lease. Returns once the
   * engine adapter has stopped or `abortTimeoutMs` elapses.
   * Unrelated in-process callers without the lease cannot terminate
   * other sessions' runs.
   */
  readonly abortActive: (
    lease: SessionLease,
    reason: KoiError,
  ) => Promise<Result<void, KoiError>>;
  readonly status: () => HarnessStatus;
  readonly createMiddleware: (lease: SessionLease) => KoiMiddleware;
  /**
   * Shut down the harness. Requires the current SessionLease when the
   * harness is `active` — enforces the same capability boundary as
   * other mutating methods. When the harness is `idle` / `suspended` /
   * `completed` / `failed`, the lease parameter is optional (pass
   * `undefined`) because there is no active run to terminate.
   */
  readonly dispose: (
    lease?: SessionLease,
    options?: {
      /**
       * Max time (ms) dispose() itself waits before returning. Background
       * retry continues until CAS success (trustedSingleProcess) or the
       * harness object is released. Default: abortTimeoutMs + 30_000.
       */
      readonly callerDeadlineMs?: number;
    },
  ) => Promise<Result<void, KoiError>>;
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

| From → To | Trigger | Snapshot? | Quiesce first? |
|-----------|---------|-----------|----------------|
| `idle → active` | `start(plan)` | yes (initial) | n/a |
| `active → active` | turn completes, policy fires | yes (soft) | no |
| `active → suspended` | `pause(lease, sessionResult)` | yes (final for session) | **yes** |
| `suspended → active` | `resume()` | yes (CAS advance) | n/a |
| `active → completed` | last task done via `completeTask` | yes (final) | **yes** |
| `active → failed` | `fail(lease, err)` or timeout | yes (best-effort) | **yes** |
| any → any (other) | rejected with `KoiError` code=`INVALID_STATE` | — | — |

**Quiesce-before-publish applies to every transition that advertises a
non-active or terminal phase.** `pause`, `fail`, `completeTask` (when it
drives `completed`), and timeout all share the same six-step algorithm
as `dispose`:

1. Validate lease (identity + WeakSet + revoked-check).
2. Revoke the lease (remove from `activeLeases`, fire `lease.abort`).
3. Keep the heartbeat loop running.
4. Signal the engine adapter and `await quiesce(abortTimeoutMs)`.
5. Branch on quiesce outcome:
   - **Quiescent:** for **non-terminal** transitions (`pause →
     suspended`), follow the same durability protocol as terminal
     paths:
     1. Build the full next snapshot (target phase = `suspended`,
        generation+1, `failureReason = "paused"`).
     2. Write a `harness-suspended` `RecoveryOutcome` via
        `sessionPersistence.recordRecoveryOutcome(sid, outcome)`
        BEFORE attempting the snapshot CAS. This is the durable
        crash-safety boundary: once the outcome record lands, a
        reclaimer can complete the transition even if this process
        dies. If the outcome write itself fails, retry 3 times; on
        sustained failure, return
        `Err(CHECKPOINT_WRITE_FAILED, retryable: true)` WITHOUT
        stopping heartbeats — the engine is quiesced but the harness
        remains reclaim-safe and the operator can retry pause().
     3. Attempt the snapshot CAS up to 4 times
        (100/500/2500/12500 ms). On success, stop heartbeats and
        return `Ok`.
     4. On CAS retry exhaustion: keep heartbeats running, transition
        `durability = "unhealthy"`, durably call
        `markCleanupUnhealthy(sid, "PAUSE_WRITE_FAILED")`, schedule
        the same background retry loop used for terminal failures
        (15s exponential, 5min cap; CAS uses the durable outcome
        record's snapshotDelta and continues until success or the
        harness object is released), and return
        `Err(CHECKPOINT_WRITE_FAILED, retryable: true)`. A reclaimer
        on a peer process can also drive this CAS via the outcome
        record.
     The pause() contract therefore guarantees: either the snapshot
     is durably `suspended` and heartbeats stop, or a durable
     `harness-suspended` outcome exists that ANY reclaimer can apply
     (heartbeats live, snapshot still `active`) — no wedged middle
     state and no lost post-quiesce delta.
     For **terminal** transitions (`completed` / `failed`), CAS failure
     MUST retry until either success or a hard retry budget exhausts
     (4 tries, same backoff). Terminal transitions cannot fall back to
     tombstones or TTL reclaim because that would leave the harness
     resumable from a pre-completion snapshot — an exactly-once
     violation: a peer reclaiming later would replay already-emitted
     side effects.

     **In-session vs session-ending updates.** `completeTask`,
     `failTask`, and other task-board mutations have two distinct
     paths depending on whether they end the current session:
     - **In-session (non-terminal):** the task board still has
       pending tasks after the update. The harness writes a regular
       soft-checkpoint (CAS `active → active` with new task-board
       state, lease still valid, engine still running, no quiesce).
       No `RecoveryOutcome` record. Heartbeats unchanged.
     - **Session-ending (terminal):** the update would leave the
       task board with no pending tasks (last task done) AND the
       caller is `completeTask`/non-retryable `failTask`. OR the
       caller is `fail`/timeout. Only these terminal callers run
       the full quiesce-and-record flow below.

     The harness internally classifies each mutation. Callers need
     not know the difference; they always invoke `completeTask`/
     `failTask`/`fail` and the harness routes correctly.

     **RecoveryOutcome (durable, full-delta-carrying).** There is NO
     caller-visible "record-intent-before-branch" API. The terminal
     path applies to: (a) `completeTask` that empties the task board,
     (b) non-retryable `failTask` that empties the task board, (c)
     any `fail(lease, err)` invocation, (d) timeout. Internally:

     1. Validate lease, revoke lease, quiesce engine (phase-machine
        steps 1–5).
     2. Build the **full next snapshot** in memory (as would be CAS'd).
        This includes updated task board, accumulated metrics,
        summaries, key artifacts, `lastSessionEndedAt`, generation+1,
        etc.
     3. **Write a durable `RecoveryOutcome` record** via
        `sessionPersistence.recordRecoveryOutcome(sid, outcome)`. The
        record carries both the discriminated-union outcome AND the
        full serialized next snapshot:
        ```
        // RecoveryOutcome is HARNESS-LEVEL ONLY (formerly
        // "TerminalOutcome"; renamed because it now also covers
        // post-quiesce SUSPENDED targets). The snapshotDelta's
        // task-board carries individual task results; the
        // discriminant captures the post-quiesce target phase.
        type RecoveryOutcomeKind =
          | { kind: "harness-completed" }              // all tasks done
          | { kind: "harness-failed"; error: KoiError } // fail()/timeout/non-retryable-failTask-empties-board
          | { kind: "harness-suspended"; reason: string } // pause()/dispose-after-kill/ABORT_TIMEOUT-with-suspended-target

        interface RecoveryOutcome {
          readonly kind: RecoveryOutcomeKind;
          readonly seq: number;                          // monotonic per session
          readonly committedAt: number;
          readonly expectedHead: ChainHead | undefined;  // CAS authority for replay
          readonly snapshotDelta: HarnessSnapshot;       // full next snapshot
          readonly resultGeneration: number;             // snapshotDelta.generation
        }
        ```
        Keyed by `(sessionId, seq)`. `expectedHead` is the chain
        head this delta was built against; `resultGeneration` is the
        delta's own generation (monotonic per harness, valid for
        ordering because generation IS a number, unlike opaque
        `ChainHead`).

        On replay, the reclaimer:
        - Reads the current chain head H and current snapshot's
          `generation` G.
        - For each outcome in seq order:
          - **Subsumption check (generation, not head):** if
            `outcome.resultGeneration <= G`, this outcome was
            already applied — skip. (`generation` is a typed monotonic
            counter; this comparison is valid.)
          - **Identity match on predecessor:** else if
            `outcome.expectedHead === H` (object/string equality on
            the opaque token), perform
            `compareAndPut(H, outcome.snapshotDelta)`; on success,
            advance H to the returned new head and update G to
            `outcome.resultGeneration`.
          - **Mismatch:** else (`expectedHead` does not equal H AND
            `resultGeneration > G`), return
            `Err(REPLAY_AUTHORITY_MISMATCH)`. The chain advanced
            via some path that is incompatible with this outcome's
            predecessor; replay cannot continue safely.

        Replay never compares `ChainHead` values for ordering — only
        equality. Subsumption uses the typed `generation` counter,
        which has well-defined ordering. The reclaimer threads H
        forward CAS-by-CAS using the head returned from each
        successful `compareAndPut`.
        Carrying the full snapshot delta makes exactly-once
        non-lossy: a reclaimer replays the snapshot from the record,
        not a reconstructed-from-outcomes partial view.
     4. Attempt the snapshot CAS to `snapshotDelta`. If it succeeds
        the outcome record is redundant (matches the now-authoritative
        head). If it fails, the harness performs background CAS retry
        using the same `snapshotDelta` until success; a reclaimer can
        also perform the CAS using the durable record.

     **`failTask` retryability rule.** `failTask(lease, id, err)`
     checks `err.retryable`:
     - **Retryable:** truly in-session — no quiesce, no lease
       revocation, no `RecoveryOutcome`. The harness performs an
       in-session soft checkpoint: CAS `active → active` with the
       task returned to `pending` and `attempts` incremented. The
       lease remains valid; the engine continues running and will
       re-attempt the task on the next turn. The `active` snapshot
       always means "a live lease holder is executing," matching
       the rest of the phase invariants. If the process crashes
       between the API call and the CAS, the reclaimer sees the
       pre-CAS snapshot — the task is still in its pre-failure
       state and a fresh session re-runs it. (At-least-once retry,
       which is what retryable failures already imply.)
     - **Non-retryable:** if it empties the task board, run the
       full session-ending terminal flow above and record a
       `harness-failed` `RecoveryOutcome` (the snapshot delta
       carries the failed task's details in its task board). If
       pending tasks remain, run the in-session non-terminal path
       — the failed task is recorded in the new `active`
       snapshot's task board (no `RecoveryOutcome` because the
       harness is still active; the snapshot is authoritative).

     **Reclaimer-side replay.** On reclamation, after
     `killAndConfirm` succeeds, the reclaimer:
     1. Calls `sessionPersistence.listRecoveryOutcomes(sid)`. Because
        `RecoveryOutcome` is harness-level only and a session
        transitions to `suspended` / `completed` / `failed` exactly
        once, the list contains AT MOST ONE record.
     2. If there is one record: CAS-replay it using the algorithm
        above (subsumption check on `resultGeneration`, identity
        check on `expectedHead`). The chain ends in `suspended`,
        `completed`, or `failed` per the record's `kind`. Reclaim is
        done; future `resume()` returns `TERMINAL` for terminal
        outcomes, or starts a fresh session for `harness-suspended`.
     3. If there are no records: the original session never reached
        a post-quiesce intent. Reclaim falls through to the standard
        "active → suspended" recovery (CAS to `suspended` with
        `RECLAIMED_FROM_DEAD_OWNER`), and `resume()` can start a
        fresh session normally. Task-board state from the last
        durable snapshot is preserved; in-progress tasks remain in
        whatever state they were last checkpointed at. **Note:** any
        cleanup path that has already quiesced the engine MUST write
        a `harness-suspended` `RecoveryOutcome` BEFORE relinquishing
        control (see pause and ABORT_TIMEOUT cleanup sections), so
        this fallback applies only to true crashes mid-execution.

     Retryable task failures and in-session updates never appear in
     `RecoveryOutcome` records — they are encoded in regular soft
     checkpoints on the snapshot chain itself.

     This closes the gaps from earlier rounds: the terminal-intent
     API is internal; "started" is never an authoritative signal
     (the record is written AFTER the branch's logical completion
     but BEFORE the snapshot CAS); the same mechanism covers
     task-level, harness-fail, and timeout paths uniformly;
     retryable task failures stay retryable; and the full snapshot
     delta (not just task outcomes) is what replay uses, so
     summaries/artifacts/metrics/`lastSessionEndedAt` are preserved
     exactly.

     **Terminal CAS authority.** The CAS itself takes the harness's
     internal head pointer + the next snapshot; it does not need a
     lease argument. Lease validation gates whether the public API
     accepts the call; once accepted, the harness performs CAS via its
     own internal state. If the initial 4-retry burst exhausts, the
     harness transitions `status().durability = "unhealthy"` (and durably
     calls `markCleanupUnhealthy(sid, "TERMINAL_WRITE_FAILED")`) and
     schedules a background retry loop (exponential backoff starting
     at 15s, capped at 5 min) that continues to attempt the terminal
     CAS for as long as the harness object is alive. Heartbeats
     continue throughout so the harness stays non-reclaimable.
     `onDurabilityLost(TERMINAL_WRITE_FAILED)` is invoked on first
     failure and on every backoff tick.

     **Exactly-once across process death.** The combination of the
     durable `RecoveryOutcome` record (written before the snapshot
     CAS) + background retry + reclaimer-side outcome application
     guarantees exactly-once durable terminal state even if the
     original process dies before the CAS succeeds: the reclaimer
     sees the outcome, applies it to the snapshot's task board, and
     CAS-advances to the terminal phase using the outcome as its
     authority — same durable-state contract, different actor. The
     outcome carries the full result, so no re-execution of the
     terminal branch occurs.
   - **Abort timeout:** do NOT publish the target phase yet. Flip
     `durability = "unhealthy"` and call
     `sessionPersistence.markCleanupUnhealthy(sid, "ABORT_TIMEOUT")`
     so the durable breadcrumb is set BEFORE any further action.
     **Then write a durable `RecoveryOutcome` carrying the intended
     post-kill snapshot** via `recordRecoveryOutcome(sid, outcome)` —
     `kind = "harness-failed"` (for fail/timeout/completeTask-terminal
     callers) or `kind = "harness-suspended"; reason = "disposed
     after kill"` (for `dispose()`). This MUST happen before any
     `killAndConfirm` call. Without this record, a process death
     between successful kill and the follow-up snapshot CAS would
     let the next reclaimer fall back to generic
     `RECLAIMED_FROM_DEAD_OWNER` suspension, resurrecting work that
     was supposed to terminate. With it, any reclaimer (including
     one in this process after kill) consumes the outcome via
     `listRecoveryOutcomes` and CAS-applies the authoritative
     post-quiesce snapshot. If the outcome write fails, retry 3
     times; on sustained failure, return
     `Err(ABORT_TIMEOUT, retryable: true)` and do NOT proceed to
     kill — heartbeats keep running and the operator can retry.
     Then:
     - **Supervisor mode (default):** the harness invokes
       `supervisor.killAndConfirm(sessionId)` automatically after a
       fixed grace period (`abortKillGraceMs`, default 30s). On
       success, the harness uses its private cleanup authority to
       CAS-advance to the target phase. Recovery is deterministic
       inside the package contract — no reliance on host SIGKILL.
       If `killAndConfirm` itself fails (`KILL_FAILED`), the
       background cleanup watcher polls + retries every
       `heartbeatIntervalMs` and re-issues `killAndConfirm` with
       backoff until success or process exit. Heartbeats continue
       throughout; peers cannot reclaim while the harness is
       actively trying to kill its own engine.
     - **`trustedSingleProcess=true` mode:** no supervisor is
       available. Heartbeats continue, the durable
       `cleanupHealth = "unhealthy"` breadcrumb is set, and
       `onDurabilityLost(ABORT_TIMEOUT)` is invoked. The host MUST
       SIGKILL — there is no automatic recovery path in this mode.
       This is documented as the explicit availability tradeoff
       for trusted-mode deployments.
     Return `Err(ABORT_TIMEOUT)` from the API call so the caller
     can act if it wants to.
6. Return the typed `Result<void, KoiError>`.

This means a late in-flight `completeTask(oldLease, …)` invoked by an
engine adapter that was supposed to be aborted cannot advance the
harness, because `oldLease` fails identity check post-revocation and
the target phase is only published after quiescence is confirmed.

### Atomic Checkpoint Write

Issue requirement: **no partial writes**. **All state-advancing writes in
this package use `SnapshotChainStore.compareAndPut(expectedHead, next)`.**
Plain `put(...)` is NOT permitted for any path that advances harness state
(activation, pause, fail, soft checkpoint, reclaim, dispose). Non-CAS
writes cannot fence stale writers and would re-introduce split-brain
advancement.

```
1. Build next HarnessSnapshot in memory (immutable), including incremented
   generation (when appropriate) and current lease's sessionId.
2. harnessStore.compareAndPut(expectedHead, next):
     a. Payload written to durable storage first.
     b. Chain pointer advanced iff current head equals expectedHead.
     c. On failure at any step, previous chain head remains authoritative.
     d. Returns a typed outcome distinguishing I/O error from CAS mismatch.
3. CAS mismatch → the caller's view is stale; reject the operation and
   let the caller re-read and retry (typically surfaces as
   CONCURRENT_RESUME, STALE_SESSION, or CHECKPOINT_WRITE_FAILED depending
   on context).
4. I/O error → retry-with-backoff where applicable (durability-loss
   recovery retries 3 times; end-user pause/fail return
   CHECKPOINT_WRITE_FAILED immediately).
```

We never mutate stored state in place. A crashed write leaves the prior
snapshot as the valid resume point. A stale writer's CAS fails and cannot
corrupt the chain.

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
4. CAS-advance harness snapshot to `active` with the new generation and
   `lastSessionId` pointing at the record from step 1. If CAS fails →
   rollback: remove lease from
   WeakSet, stop heartbeats, best-effort `removeSession(sid)`, return
   `CONCURRENT_RESUME`. Any durable orphan is cleaned by reconciliation.
5. Attempt `sessionPersistence.setSessionStatus(sid, "running")`.
   Regardless of outcome, the harness snapshot is already `active`, the
   heartbeat is running, and the lease is minted. We MUST always return
   the lease so the caller can eventually relinquish.
   - **On success:** if the prior `prev.lastSessionId` had
     `cleanupHealth === "unhealthy"`, best-effort
     `sessionPersistence.clearCleanupUnhealthy(prev.lastSessionId)`
     (idempotent; failure is logged but does not fail activation —
     the breadcrumb is allowed to linger and re-clear on next resume).
     Return `Ok(StartResult { lease, engineInput, sessionId,
     activationWarning: undefined })`.
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

1. `sessionPersistence.loadSession(sid)` → `record: SessionRecord | NOT_FOUND | IO_ERROR`.
   On `IO_ERROR` (any return other than a record or explicit NOT_FOUND):
   retry up to 3 times with exponential backoff (100/500/2500 ms). If all
   retries fail, return `KoiError { code: "RECLAIM_READ_FAILED", retryable: true }`
   to the caller — do NOT reclaim. Any reclaim decision below REQUIRES a
   **double-confirmation** protocol to defend against stale replica reads:
   after the first dead-owner signal, wait `heartbeatIntervalMs * 2`, then
   re-read. Reclaim proceeds only if the second read also shows dead-owner
   semantics. This prevents a single stale read from fencing a live
   heartbeating owner — the second read is expected to see the fresh
   heartbeat if the original owner is alive.
2. Decide the owner's liveness. **TTL staleness is the ONLY primary
   dead-owner signal** — status flags are advisory. This avoids relying on
   cross-store read-after-write consistency between `harnessStore` and
   `sessionPersistence`, which L0 does not guarantee:
   - `NOT_FOUND` → **not a short-term dead-owner signal.** Enter the
     **orphan-detection loop**:

     ```
     orphanWindow = leaseTtlMs + heartbeatIntervalMs    // default 120s
     pollInterval = heartbeatIntervalMs / 2             // default 15s
     deadline = Date.now() + orphanWindow
     while (Date.now() < deadline):
         sleep(pollInterval)
         reread = loadSession(sid)
         if reread is a record → exit loop, re-run reclamation check
                                  with the now-visible record.
         if reread is IO_ERROR → exit loop, return RECLAIM_READ_FAILED.
         // still NOT_FOUND → continue polling.
     ```

     If the loop exits with NOT_FOUND sustained across the entire
     `orphanWindow`, treat as **orphan-suspected**, but do NOT
     automatically terminalize — a read-path fault could mimic this
     signature even when the owner is healthy. Instead:
     - Run the supervisor probe-then-kill protocol. If `probeAlive`
       returns `"alive"` → return `Err(RECLAIM_LIVE_OWNER)`; do not
       kill. If `probeAlive` returns `"dead"` (or sustained
       `"unknown"` paired with the orphan-window NOT_FOUND signal),
       call `killAndConfirm(lastSessionId)` (idempotent on a dead
       worker). On `killAndConfirm` success: apply any RecoveryOutcome
       records first (see Reclaimer-side replay below), then if no
       terminal outcomes exist, CAS-advance the snapshot to
       `suspended` (NOT `failed`) with `failureReason =
       "ORPHAN_RECOVERED"`, generation+1. `suspended` is recoverable:
       a later `resume()` starts a fresh session. We never publish
       `failed` from NOT_FOUND evidence alone.
     - On `probeAlive === "unknown"` without corroborating signals or
       on `Err(IO_ERROR)`: return `Err(SUPERVISOR_UNHEALTHY)`.
     - On `killAndConfirm` returning `Err(KILL_FAILED)` (supervisor
       unhealthy): return `Err(KILL_FAILED, retryable: true)` without
       mutating state.
     - Bounded recovery time: ≤ `leaseTtlMs + heartbeatIntervalMs` +
       supervisor kill latency.

   Read I/O errors (not NOT_FOUND) remain `RECLAIM_READ_FAILED`
   (retryable) — we do NOT treat a transient read error as a missing
   record. The initial 3-retry backoff (100/500/2500ms) applies ONLY to
   I/O errors, not to NOT_FOUND. NOT_FOUND enters the orphan-detection
   loop directly.
   - `record.status === "done"` → advisory signal of clean exit, but still
     require TTL-stale heartbeat before reclaim (protects against lagged
     reads of an old status).
   - `record.status === "idle"` → same: advisory, require TTL-stale
     heartbeat.
   - `record.status === "abandoned"` → **advisory signal only** that
     the prior lease holder believed the run was ended. Because
     `setSessionStatus` is not fenced by generation/lease in L0, the
     tombstone cannot be treated as authoritative on its own (a buggy
     or stale actor could have written it). Reclaim still requires
     supervisor `killAndConfirm` AND one of (a) TTL-stale heartbeat
     with double-confirmation or (b) sustained orphan-window NOT_FOUND.
     The tombstone accelerates recognition of completed runs but does
     not bypass the standard fencing; it is a hint, not proof.
   - `record.status ∈ { "starting", "running" }` — apply TTL rule with
     **double-confirmation**:
     - `now - record.lastHeartbeatAt > leaseTtlMs` → first dead signal.
       Wait `heartbeatIntervalMs * 2`, re-read. If second read is also
       stale (no newer `lastHeartbeatAt`) → **dead**, reclaim. If second
       read shows a fresher heartbeat → **live** (stale read on first
       attempt) → `ALREADY_ACTIVE`.
     - Heartbeat fresh → **live**. `ALREADY_ACTIVE`.

   Double-confirmation adds at most `2 * heartbeatIntervalMs` (default
   60s) to reclaim latency in exchange for read-lag tolerance. A genuine
   dead owner stays dead; a live owner that was briefly misread by a
   lagging replica is correctly identified by the second read.

Unified rule: **reclaim requires (1) a positive dead-owner signal from
session persistence — a loadable session record whose heartbeat is
stale beyond `leaseTtlMs` with double-confirmation, OR sustained
NOT_FOUND across `orphanWindow` — AND (2) supervisor-confirmed kill
of the prior worker.** Snapshot age is NEVER a dead-owner signal on its
own. Status flags (`"done"` / `"idle"` / `"abandoned"`) accelerate
recognition but never substitute for heartbeat-TTL evidence;
`setSessionStatus` is not lease-fenced in L0, so status reads can
reflect stale or incorrect tombstone writes.

`"starting"` is informational only. A live owner mid-activation heartbeats
(loop started in activation step 2) and holds the lease; a crashed
mid-activation owner goes stale within TTL. This closes both the
activation-latency race and the cross-store-lag race.
3. To reclaim — outcome-driven, never bypass durable terminal state:
   - First, `listRecoveryOutcomes(prev.lastSessionId)`.
   - If a record exists (at most one — RecoveryOutcome is
     harness-level only): CAS-replay it via the subsumption +
     identity-match algorithm above. The chain ends in `completed`
     or `failed`. Reclamation ENDS — future `resume()` returns
     `TERMINAL`. We never bypass a durable terminal outcome.
   - If no record exists: CAS-advance `prev` → `next` with
     `phase = "suspended"`, `generation = prev.generation + 1`,
     `failureReason = "RECLAIMED_FROM_DEAD_OWNER"`. Re-enter resume
     flow.

   Outcome replay is gated by the same `probeAlive`/`killAndConfirm`
   protocol — never replay outcomes for a session whose worker the
   supervisor reports as alive.

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
    most recent write failed: **invoke `_abortActiveAndRecover(lease,
    HEARTBEAT_STALE)` immediately** — the same recovery path the
    checkpoint middleware uses on store I/O failure. This revokes the
    lease, quiesces the engine, then attempts the recovery CAS to
    `suspended` (with snapshot-store retry → fall back to TTL/
    supervisor in default mode, or background-retry in
    `trustedSingleProcess` mode). The heartbeat-stale path no longer
    uses the public `abortActive`, which lacks a fencing CAS.
  - `onDurabilityLost` is invoked on the first failed write, not after
    contiguous failures.
- Lease validation (before every mutating store write) refreshes the
  heartbeat before the CAS. If that heartbeat write fails, the mutation
  is rejected with `CHECKPOINT_WRITE_FAILED` and
  `_abortActiveAndRecover` is invoked through the same recovery path.
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

**L0 prerequisites:** see the canonical "L0 Prerequisites (coordinated
breaking change)" section below for the complete dependency list.
That section is authoritative — implementers MUST consult it (not any
shorter summary) before treating prereqs as met. The list there
includes generation, CAS, lastHeartbeatAt, the SessionStatus delta,
`SnapshotChainStore.latest()`, `setHeartbeat()`,
`recordRecoveryOutcome()`/`listRecoveryOutcomes()`,
`HarnessStatus.durability`, and `cleanupHealth` +
`markCleanupUnhealthy`/`clearCleanupUnhealthy`. Skipping any of them
silently drops reclaim safety or post-crash terminal recovery.

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
5. **On abort timeout (engine refuses to stop):** apply the canonical
   ABORT_TIMEOUT contract defined in the phase-machine "Abort
   timeout" branch (see "Phase Machine — Abort timeout" above). In
   summary, that contract specifies:
   - Do NOT advance to `failed` yet. Snapshot stays `active`,
     heartbeats keep running (harness is non-reclaimable).
   - `status().durability = "unhealthy"`,
     `markCleanupUnhealthy(sid, "ABORT_TIMEOUT")`,
     `onDurabilityLost(ABORT_TIMEOUT)` invoked.
   - **Supervisor mode:** harness invokes
     `supervisor.killAndConfirm(sessionId)` automatically after
     `abortKillGraceMs`; on success the private cleanup authority
     CAS-advances to `failed` with `failureReason = "TIMEOUT"` and
     stops heartbeats. Recovery is automatic.
   - **`trustedSingleProcess=true` mode:** no supervisor available;
     host MUST SIGKILL. No automatic recovery.
   This is the SINGLE source of truth for ABORT_TIMEOUT across all
   callers (pause/fail/timeout/dispose). The dispose section's
   "background watcher" is the same private-cleanup-authority
   mechanism described here, parameterized for the dispose target
   phase (`suspended`) instead of `failed`.

The TS `failed` phase remains a strong signal: "engine has stopped,
scheduler may now act terminally." If the engine cannot be stopped, we
loudly refuse to lie about it.

### Cleanup on Abandonment

`dispose()` is idempotent and follows the quiesce-before-publish rule. It
MUST NOT publish a `suspended` snapshot while the engine is still producing
side effects — that would let a replacement process resume in parallel with
the original run.

Unambiguous algorithm:

1. Validate the lease argument if phase is `active`: identity check +
   WeakSet membership. Missing or stale → `Err(STALE_SESSION)`. For
   non-active phases, the lease is optional.
2. Stop ONLY the wall-clock timeout timer (`clearTimeout(timeoutHandle)`).
   **Do NOT stop the heartbeat timer.** Heartbeats must continue.
3. If phase is not `active`, return `Ok(undefined)` — nothing further.
4. Revoke the lease (remove from `activeLeases`, fire `lease.abort`).
   In-process callers with the old reference now fail identity check.
4. Signal the engine adapter to stop, then `await quiesce(abortTimeoutMs)`.
5. Throughout step 4, the heartbeat loop continues unchanged. Config
   invariant `abortTimeoutMs < leaseTtlMs - 2 * heartbeatIntervalMs`
   guarantees at least one heartbeat will succeed during the quiesce
   window even if one misses.
6. Branch on the quiesce outcome:
   - **Quiescent:** CAS-advance to `suspended` with
     `failureReason = "disposed before completion"`. Retry policy
     depends on mode:
     - **Supervisor mode (default):** 4-try backoff (100/500/2500/
       12500ms). On success, stop heartbeats and release store
       references; return `Ok(undefined)`. On failure, stop
       heartbeats anyway — the engine is confirmed stopped and TTL
       staleness + supervisor `killAndConfirm` (no-op on a dead
       process) will safely reclaim.
     - **`trustedSingleProcess=true` mode:** no supervisor, so TTL
       reclaim is disabled. The dispose CAS MUST eventually succeed
       to avoid a permanent `active` wedge. Heartbeats continue
       until CAS success. Harness retries in the background with
       exponential backoff (15s initial, capped at 5 min), logging
       each failure via `onDurabilityLost`. `dispose()` returns
       `Ok(undefined)` once CAS succeeds. Callers that want early
       return can pass a deadline; if the deadline elapses, return
       `Err(DISPOSE_STORE_UNREACHABLE)` but the background retry
       continues until the harness object is released. An operator
       who believes the store is permanently broken can edit the
       snapshot out of band via a separate administrative tool.
   - **Timed out (engine ignored abort):** apply the canonical
     ABORT_TIMEOUT contract (see phase-machine "Abort timeout"
     branch — single source of truth). Specifically for `dispose()`:
     - Do NOT publish `suspended` yet; heartbeats keep running.
     - `status().durability = "unhealthy"`,
       `markCleanupUnhealthy(sid, "ABORT_TIMEOUT")`,
       `onDurabilityLost(ABORT_TIMEOUT)` invoked.
     - **Supervisor mode:** harness invokes
       `supervisor.killAndConfirm(sessionId)` after
       `abortKillGraceMs`; on success a **private cleanup authority**
       (not a `SessionLease`; survives lease revocation)
       CAS-advances to `suspended` with
       `failureReason = "disposed after kill"` and stops heartbeats.
     - **`trustedSingleProcess=true` mode:** no supervisor; the same
       private cleanup authority polls the engine adapter's running
       state every `heartbeatIntervalMs` and CAS-advances to
       `suspended` once the engine actually reports quiescence (e.g.,
       host SIGKILL eventually clears the run, or the engine exits
       on its own). Heartbeats continue until CAS success.
     - Subsequent `dispose()` calls on this harness object return
       `Err(ABORT_TIMEOUT)` immediately (cleanup authority is
       authoritative; phase check rejects re-entry). The original
       `dispose()` returns `Err(ABORT_TIMEOUT)`.

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
   `unhealthy` (`status().durability = "unhealthy"`). Fail the turn with
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
3. **Stop engine execution before giving up the lease.** The middleware
   calls a distinct internal entry point,
   `harness._abortActiveAndRecover(lease, reason)`, that:
   (a) **immediately removes the lease from `activeLeases`** — any
   subsequent public mutating API call with that lease returns
   `STALE_SESSION`, closing the late-callback window during recovery;
   (b) fires the lease's AbortSignal;
   (c) transfers CAS authority to a private `RecoveryToken` held only
   by this function — this token is what the recovery CAS uses,
   decoupled from the revoked `SessionLease`;
   (d) waits up to `abortTimeoutMs` for engine quiescence;
   (e) attempts the recovery CAS using the `RecoveryToken`.
   This privileged internal path is NOT exposed on the public surface;
   only the middleware bundled with this package can call it.
   `abortActive(lease, reason)` remains the public, lease-revoking
   variant — it is used for callers that only need to stop execution
   and don't need the recovery CAS window.

   **Lease poisoning invariant.** `_abortActiveAndRecover` ALWAYS
   removes the caller's lease from `activeLeases` before returning,
   regardless of whether the recovery CAS succeeds, fails, or the
   fallback path runs. Additionally, any late in-process caller
   holding the old lease reference must fail identity check on every
   mutating API — the WeakSet is authoritative, so removal is
   sufficient. The harness also retains an in-memory
   `revokedLeases` WeakSet (weak references only, cleaned on GC)
   used to distinguish "forged lease" from "revoked lease" in error
   messages but otherwise behaves identically for authorization.
   This guarantees: after any recovery branch, the old lease is
   dead even if the fencing CAS failed and TTL reclaim is pending.
4. Once quiesced, **attempt immediate fencing so recovery does not wait for
   TTL**. This is critical: merely stopping heartbeats and marking the
   session `idle` leaves the authoritative snapshot as `active`, and
   reclaim rules require TTL staleness — so a single transient I/O fault
   could block failover for up to `leaseTtlMs`. The only authoritative
   fast-path is a successful snapshot-store CAS. We do not use the
   `abandoned` tombstone as an immediate-reclaim primitive (see Reclaim
   — status flags are advisory only; reclaim still requires
   TTL-stale heartbeat OR sustained NOT_FOUND AND supervisor kill):
   - **Retry the snapshot store.** I/O failures are often transient;
     the initial `compareAndPut` is retried with exponential backoff
     (default 3 tries, 100/500/2500ms). On success, advance to
     `suspended` with `failureReason = "CHECKPOINT_WRITE_FAILED"` and
     a new generation. The harness is now `suspended`; any `resume()`
     proceeds immediately with no TTL wait. This is the only path to
     sub-TTL recovery.
   - **Write `abandoned` tombstone as an advisory hint.** Regardless
     of CAS outcome, call `setSessionStatus(sid, "abandoned")`. This
     accelerates operator diagnostics (monitoring can page on
     abandoned records) but does NOT short-circuit reclaim rules. A
     peer still needs TTL-stale heartbeat or sustained NOT_FOUND AND
     supervisor kill.
5. After step 4, behavior depends on mode:
   - **Supervisor mode (default):** if the CAS succeeded, stop the
     heartbeat loop; a peer `resume()` finds `phase === "suspended"`
     and proceeds with no TTL wait. If the CAS failed after retry,
     stop heartbeats anyway — recovery falls back to TTL-staleness
     + supervisor probe-then-kill, bounded by `leaseTtlMs + 2 *
     heartbeatIntervalMs` worst case.
   - **`trustedSingleProcess=true` mode:** there is no supervisor and
     no TTL reclaim path, so the harness MUST eventually publish
     `suspended` itself. On CAS retry exhaust:
     - Do NOT stop heartbeats (no peer can reclaim, but a stopped
       heartbeat under this mode would prevent any recovery and
       leave the snapshot in `active` forever).
     - Schedule a background CAS retry loop (15s / cap 5min, same
       as terminal-write retry) that continues until success.
       `_abortActiveAndRecover` returns
       `Err(CHECKPOINT_WRITE_FAILED)` to the middleware caller, but
       the background loop owns the eventual transition.
     - On background CAS success: stop heartbeats; harness is
       `suspended`. Operator can `resume()` normally.
     - This mirrors the dispose-in-trusted-mode behavior so the
       harness is never wedged in `active` permanently in the
       configuration that disables supervisor reclaim.
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
- `pause()` follows quiesce-before-publish: revoke lease, abort engine,
  await quiescence, then CAS to `suspended` with `SessionResult`. On
  abort timeout, returns `Err(ABORT_TIMEOUT)` without publishing
  `suspended`.
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
  `onDurabilityLost`, calls `_abortActiveAndRecover(...)` (internal
  deferred-revocation variant) which aborts the engine then attempts the
  recovery CAS to `suspended`. On CAS success: heartbeats stop and the
  advisory `"abandoned"` status is written (best-effort, diagnostics only).
  On CAS failure: heartbeats stop anyway — TTL-stale heartbeat + supervisor
  kill will reclaim safely (engine is confirmed stopped). No silent
  degradation. No continue-with-in-memory escape hatch.
- Engine refuses to abort within `abortTimeoutMs` → heartbeats continue
  indefinitely and session status is NOT changed from `"running"`;
  `onDurabilityLost(ABORT_TIMEOUT)` surfaced — host must SIGKILL.
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
- **Late callback after pause:** `pause()` in-flight → engine adapter's
  pending `completeTask(oldLease, …)` callback runs during the quiesce
  wait → rejected with `STALE_SESSION`. `suspended` snapshot is published
  only after quiescence is confirmed; no late mutation ever sees a
  published non-active state.
- **Late callback after fail:** same as above with `fail(lease, err)` —
  `failed` snapshot is not published until engine is confirmed stopped.
- **pause/fail abort timeout:** engine refuses to quiesce → `pause()` or
  `fail()` return `Err(ABORT_TIMEOUT)`, do NOT publish `suspended`/
  `failed`, keep heartbeats running, flip `durability = "unhealthy"`.
  Host must SIGKILL. (Regression: no "ghost" terminal state ever visible
  to external scheduler while engine still runs.)
- **Stale writer vs. replacement session:** `start` → `pause` → `resume` mints a
  new lease; an in-flight caller holding the first lease attempts
  `completeTask` → rejected with `STALE_SESSION`; new lease's writes succeed.

### Unit: crash recovery (`harness.test.ts`)

- **Crash mid-activation, heartbeat stale:** snapshot=`active` + session
  record=`"starting"` + `lastHeartbeatAt < now - leaseTtlMs` sustained
  across double-confirmation window. Supervisor returns `Ok` from
  `killAndConfirm`. Second process calls `resume()` → CAS-advances to
  `suspended` → new session resumes. Never publishes `failed`.
- **Crash mid-run with stale heartbeat:** snapshot=`active` + session record
  `status="running"`, `lastHeartbeatAt < now - leaseTtlMs` sustained across
  double-confirmation, supervisor kill-ok → CAS to `suspended`, resume
  proceeds.
- **Live owner blocks reclaim:** snapshot=`active` + fresh heartbeat →
  `resume()` returns `ALREADY_ACTIVE`.
- **Orphan session record after partial activation:** session written but CAS
  failed. Next `resume()` ignores orphan (no pointer from harness); periodic
  reconciliation (`pruneOrphanSessions`) removes it.
- **Durability loss mid-run with transient fault:** I/O failure on soft
  checkpoint → middleware aborts engine → after quiescence, snapshot-store
  retry with backoff succeeds → `suspended` snapshot published →
  immediate `resume()` proceeds without TTL wait.
- **Durability loss mid-run with persistent fault:** snapshot-store
  retries all fail → `setSessionStatus("abandoned")` written as an
  advisory hint but NOT treated as authoritative → heartbeat loop
  stopped → reclaim via TTL staleness + supervisor kill. Tombstone is
  informational only.
- **Terminal-write failure preserves exactly-once:** `completeTask`
  quiesces engine, CAS to `completed` fails repeatedly (simulated
  store outage). Harness returns `Err(TERMINAL_WRITE_FAILED)`, stays
  `active + unhealthy`, heartbeats continue. Peer `resume()` returns
  `ALREADY_ACTIVE`. Work already emitted by the completed task cannot
  be re-executed because no peer can reclaim until the original caller
  retries the terminal CAS. (Regression against duplicate terminal
  work.)
- **Long-turn heartbeat:** a single turn that exceeds `leaseTtlMs` without
  reaching a checkpoint boundary continues to heartbeat via the timer loop;
  a concurrent `resume()` attempt returns `ALREADY_ACTIVE`, not a successful
  reclamation. (Regression test for false dead-owner reclamation.)
- **Heartbeat-write failure proactive abort:** simulated `setHeartbeat` I/O
  failure with `lastPersistedHeartbeatAt` approaching TTL → harness invokes
  `abortActive` before TTL expires → no competing `resume()` can reclaim
  while execution is still ongoing.
- **Heartbeat loop lifecycle:** heartbeat starts on `start()`/`resume()` and
  stops ONLY after engine quiescence is confirmed AND the resulting CAS
  to a non-active phase succeeds. Specifically:
  - `pause(lease, result)` quiesce-success → CAS `suspended` success → stop.
  - `fail`/`completeTask → completed` quiesce-success → CAS success → stop.
  - `dispose()` quiesce-success + supervisor mode → CAS retry-exhaust →
    stop (TTL reclaim is safe because engine is already dead).
  - `dispose()` quiesce-success + `trustedSingleProcess` → stop ONLY after
    CAS eventually succeeds (background retry). Until success,
    heartbeats continue.
  - `dispose()`/`pause()`/`fail()` quiesce-TIMEOUT → heartbeats continue
    indefinitely (engine is still running; host must SIGKILL).
  - Terminal-write exhaust (TERMINAL_WRITE_FAILED with background retry)
    → heartbeats continue until background CAS succeeds.
  Verified by dedicated negative tests for each abort-timeout and
  background-retry case.
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
  returns `NOT_FOUND` briefly for a freshly-written session record while the
  snapshot store already shows `active`. Reclamation does NOT treat a single
  `NOT_FOUND` as dead-owner; it enters the orphan-detection loop and when
  the record becomes visible mid-loop, restarts reclamation with the
  visible record and returns `ALREADY_ACTIVE`. Reclaim requires either a
  loadable record with stale heartbeat (double-confirmed) OR sustained
  `NOT_FOUND` for the full orphan window AND supervisor-confirmed kill.
  `abandoned` status never bypasses these rules. (Regression against
  cross-store split-brain.)
- **`loadSession` I/O error during reclaim:** simulated read failure
  during reclaim. Harness retries 3x with backoff; if all fail, returns
  `RECLAIM_READ_FAILED` (retryable). Does NOT attempt reclaim, does NOT
  wedge the harness — the existing state is untouched and a later
  `resume()` call can proceed once the store recovers.
- **Orphan session record + supervisor kill-ok:** `loadSession` returns
  `NOT_FOUND` for the full orphan window. Supervisor returns `Ok` from
  `killAndConfirm`. Harness CAS-advances to `suspended` with
  `ORPHAN_RECOVERED`; next `resume()` starts a fresh session. Never
  publishes `failed`.
- **Orphan session record + supervisor reports live owner:** supervisor
  returns `Err(RECLAIM_LIVE_OWNER)`. Harness state unchanged; caller
  receives retryable error. Regression against killing a healthy worker
  based on a read-path fault.
- **Orphan session record + supervisor unhealthy:** supervisor returns
  `Err(KILL_FAILED)`. Harness state unchanged; caller receives
  retryable error.
- **Transient NOT_FOUND (read replica lag):** first read returns
  `NOT_FOUND`, subsequent polls within `orphanWindow` see the actual
  record → orphan loop exits, reclamation re-runs with the visible
  record (TTL double-confirmation applies). No false orphan
  classification.
- **Stale heartbeat double-confirmation:** first read shows
  `lastHeartbeatAt > leaseTtlMs` but a `heartbeatIntervalMs * 2` wait
  then shows a fresh heartbeat → `ALREADY_ACTIVE`, no reclaim.
  Regression against stale-replica misclassification of live owners.
- **`trustedSingleProcess=true`:** `resume()` on any `active` snapshot
  returns `ALREADY_ACTIVE` unconditionally, no reclaim attempted even
  with stale heartbeats. Required for hosts without kill-on-takeover
  supervisor; verified by test that asserts reclaim is never invoked.
- **`createLongRunningHarness` rejects missing supervisor:** config
  without `supervisor` AND without `trustedSingleProcess=true` returns
  `INVALID_CONFIG` at construction time.
- **Supervisor kill before reclaim (TTL path):** double-confirmed stale
  heartbeat → harness calls `supervisor.killAndConfirm(lastSessionId)`
  BEFORE CAS → kill succeeds → CAS advances. Mock supervisor asserts
  ordering.
- **Supervisor kill before orphan recovery:** orphan-window elapses
  with NOT_FOUND → harness calls `killAndConfirm` → kill succeeds →
  CAS to `suspended` with `ORPHAN_RECOVERED` (recoverable, NOT
  terminal). If kill returns `RECLAIM_LIVE_OWNER` (worker still alive
  despite missing record), harness does NOT CAS and returns the error
  retryable.
- **Supervisor kill failure aborts reclaim:** mock supervisor returns
  `Err(KILL_FAILED)` → reclaim does NOT CAS, harness state unchanged,
  error propagates to caller. (Regression against split-brain-on-
  supervisor-failure.)
- **abortActive requires lease:** invoking `abortActive` with an
  unrelated lease (mint a session, close it, try its stale lease) or
  a forged lease returns `STALE_SESSION`. No session termination
  occurs.

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
| `TERMINAL_WRITE_FAILED` | terminal CAS (`completed` / `failed`) failed after retries; harness stuck `active + unhealthy`; background retry continues; exactly-once preserved | true |
| `DISPOSE_STORE_UNREACHABLE` | `trustedSingleProcess` dispose CAS unreachable past caller deadline; background retry continues | true |
| `ALREADY_ACTIVE` | `resume()` while another session holds an active lease | true |
| `CONCURRENT_RESUME` | CAS failed: peer claimed the lease first | true |
| `STALE_SESSION` | mutating call presented a revoked/superseded/tampered lease | false |
| `CHECKPOINT_WRITE_FAILED` | store `put`/`compareAndPut`/`setHeartbeat` rejected (I/O) | true |
| `HEARTBEAT_STALE` | heartbeat persistence approaching TTL with recent failure | false |
| `ABORT_TIMEOUT` | engine did not quiesce within `abortTimeoutMs` | false |
| `INVALID_CONFIG` | `abortTimeoutMs >= leaseTtlMs - 2*heartbeatIntervalMs` | false |
| `ACTIVATION_STATUS_WRITE_FAILED` | step-5 `setSessionStatus("running")` write failed; returned via `StartResult.activationWarning`, NOT via `Err`; lease is still valid | true |
| `RECLAIM_READ_FAILED` | `sessionPersistence.loadSession` I/O error during reclaim after 3 retries; caller must retry after backoff | true |
| `ORPHAN_RECOVERED` | session record consistently `NOT_FOUND` across TTL window AND supervisor confirmed kill; harness CAS-advanced to `suspended` (recoverable, not terminal) | true |
| `KILL_FAILED` | `supervisor.killAndConfirm` could not terminate the owner worker | true |
| `RECLAIM_LIVE_OWNER` | supervisor reports owner is still alive despite TTL-stale heartbeat or NOT_FOUND; caller investigates | true |
| `SUPERVISOR_UNHEALTHY` | `supervisor.probeAlive` returned IO_ERROR; reclaim aborted to avoid killing on a failed probe | true |
| `REPLAY_AUTHORITY_MISMATCH` | RecoveryOutcome.expectedHead does not match observed chain head and is not subsumed; replay aborted | false |
| `RESUME_CORRUPT` | snapshot fails `isHarnessSnapshot` | false |

## References

- v1 archive: `archive/v1/packages/sched/long-running/` — blueprint for the runtime
  (28K LOC; we port only the harness + checkpoint subset, ~500 LOC).
- L0 contract: `packages/kernel/core/src/harness.ts`, `session.ts`, `snapshot-chain.ts`.
- Claude Code: `src/tasks/LocalMainSessionTask.ts` — validates the
  background/resume/notify UX pattern (single-process analogue).

## L0 Prerequisites (coordinated breaking change)

These changes are NOT backward-compatible, contrary to earlier drafts.
Current v2 code assumes `SessionStatus` is `"running" | "idle" | "done"`
(SQLite parser, recovery logic, crash-candidate detection all key off
this), `SnapshotChainStore` exposes only `put`, and `HarnessStatus` has
no `durability` field. Adding `"starting"` / `"abandoned"` will cause
existing SQLite/memory stores to reject persisted rows; adding
`compareAndPut` requires every existing store implementation to gain a
real CAS path or fail the contract test; adding `durability` requires
every `HarnessStatus` consumer to handle the new field.

**Migration plan (land before the L2 package):**

1. **L0 type additions (single PR):** introduce the new fields/methods
   on the interfaces with sensible defaults — new `SessionStatus`
   variants are recognized by parsers but treated as `"running"` in
   legacy comparators; `compareAndPut` is added to
   `SnapshotChainStore` with a default-implementation helper that
   implementations can adopt; `HarnessStatus.durability` defaults to
   `"ok"`. This PR compiles against the current tree without changing
   behavior.
2. **Adapter upgrades (per-store PRs):**
   - `packages/lib/session/src/persistence/sqlite-store.ts`: extend
     SQLite schema + parser to accept `"starting"` / `"abandoned"`.
     Add a migration for existing databases.
   - `packages/lib/session/src/persistence/memory-store.ts`: drop old
     exhaustive narrowing of `SessionStatus`.
   - Every `SnapshotChainStore` implementation
     (`packages/lib/snapshot-store-sqlite`,
     `packages/lib/snapshot-chain-store`, any in-memory variants):
     implement real `compareAndPut` with a store-level atomicity test
     in that package's `__tests__/`.
   - Recovery code that treats `"running"` as crash-candidate must now
     also treat `"starting"` the same way (same TTL rule).
3. **Contract tests:** add shared contract tests in `@koi/core` that
   every `SnapshotChainStore` implementation must pass, including a
   concurrent CAS race test. Any existing adapter failing the test
   must be updated before the migration PR merges.
4. **L2 `@koi/long-running` PR:** after steps 1-3 are merged and green
   in CI, this L2 package can be implemented.

The L2 package's design does not regress if this migration is deferred
— but it cannot be implemented until the L0 migration lands.

Additive changes required (part of the coordinated migration):

**`@koi/core` — `HarnessSnapshot` (harness.ts):**
1. `generation: number` — monotonic per harness, incremented on every
   session transition. Drives lease fencing.

**`@koi/core` — `SnapshotChainStore` (snapshot-chain.ts):**
2. Add a `ChainHead` opaque token type (branded string; encodes the
   current chain position). Existing DAG-style API stays; we add:

   ```ts
   interface SnapshotChainStore<T> {
     // existing API unchanged …
     readonly latest: (chainId: ChainId) =>
       | Promise<Result<{ readonly head: ChainHead; readonly snapshot: T }
                        | undefined, KoiError>>
       | Result<...>;
     readonly compareAndPut: (
       expected: ChainHead | undefined,        // undefined = chain empty
       next: T,
     ) => Promise<Result<{ readonly head: ChainHead }, KoiError>>
        | Result<...>;
     // compareAndPut error codes include:
     //   CAS_MISMATCH (expected != current head; head returned)
     //   IO_ERROR (store unhealthy)
   }
   ```

   The spec uses `latest()` and `compareAndPut(prev.head, next)` throughout
   — both must exist in L0 before implementation. Existing `put()` remains
   for non-advancing writes (e.g. recording orphan snapshots during
   reconciliation).

**`@koi/core` — `SessionRecord`/`SessionStatus`/`SessionPersistence`
(session.ts):**
3. `SessionRecord.lastHeartbeatAt: number | undefined` — liveness signal.
4. `SessionStatus` gains `"starting"` (between `idle` and `running`) and
   `"abandoned"` (advisory tombstone; monitoring/diagnostics only —
   reclaim still requires TTL-stale heartbeat or sustained NOT_FOUND
   AND supervisor kill).
5. `SessionPersistence.setHeartbeat(sessionId, timestampMs)` — dedicated
   cheap-write method so the heartbeat loop does not compete with full
   `saveSession` writes.
6. `SessionPersistence.recordRecoveryOutcome(sid, outcome)` +
   `listRecoveryOutcomes(sid)` — durable record of the harness-level
   post-quiesce intent (`harness-completed` | `harness-failed` |
   `harness-suspended`). At most one record per session. Written
   after engine quiescence but before the snapshot CAS (and, for
   ABORT_TIMEOUT, before `killAndConfirm`); consulted by reclaimers
   to deferred-CAS the missed phase advance. Enforces exactly-once
   durable state across process death for both terminal and
   post-quiesce-suspended transitions. See `RecoveryOutcome` in
   phase machine.

**`@koi/core` — `HarnessStatus` (harness.ts):**
7. `durability: "ok" | "unhealthy"` — in-memory observable degraded-
   state signal. Default `"ok"`; flips to `"unhealthy"` on
   `ABORT_TIMEOUT` or sustained heartbeat-write failure. In-memory
   only; lost on process exit. Use #8 for cross-restart visibility.

**`@koi/core` — `SessionRecord` + `SessionPersistence` (session.ts):**
8. `SessionRecord.cleanupHealth: "ok" | "unhealthy"` plus
   `SessionPersistence.markCleanupUnhealthy(sid, reason)` and
   `SessionPersistence.clearCleanupUnhealthy(sid)` — DURABLE
   degraded-state marker on the session record (NOT the snapshot
   chain). The harness writes via `markCleanupUnhealthy` whenever
   the in-memory `durability` flips, regardless of snapshot-CAS
   health. Placing this on the session record (independent durable
   channel) means a snapshot-store outage does not also block the
   cleanup-health breadcrumb: even when the harness is stuck
   `active` because every snapshot CAS is failing, the session
   record's `cleanupHealth = "unhealthy"` is observable across
   process death. The session-record write itself can also fail; if
   both stores are simultaneously unreachable, no breadcrumb exists
   — but at that point the entire system is degraded and operators
   should already be paging via supervisor/store monitoring.
   Cleared via `clearCleanupUnhealthy(prev.lastSessionId)` (the
   PRIOR session record — activation creates a fresh session, so the
   marker lives on the previous one) on the next successful `start()`
   / `resume()` activation. Best-effort; clear failure does not fail
   activation, and the breadcrumb re-clears on the next resume.
   Hosts SHOULD page on
   `cleanupHealth === "unhealthy"` regardless of process state.

These land across the migration PRs listed above, not a single "prereq PR".
Implementation of `@koi/long-running` is blocked on ALL of the above.

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
