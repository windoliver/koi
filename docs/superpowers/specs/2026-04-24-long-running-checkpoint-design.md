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

**Durable worker handle.** The supervisor identifies workers via a
`WorkerHandle` (PID, pod name, systemd unit name, etc.) — NOT raw
session IDs. During activation, the harness asks the supervisor to
mint a handle for the new worker and persists it on the session
record so peer reclaimers can address the right worker after process
or supervisor restarts:

```ts
type WorkerHandle = string; // opaque, supervisor-defined; MUST embed
                            // a non-reusable identity component
                            // (e.g. "pid:12345@start=1714000000",
                            // "pod:ns/name@uid=abc-123",
                            // "unit:koi-worker@invocation=def-456").
```

**One-session-per-worker isolation (mandatory).** A given
`WorkerHandle` MUST identify a worker that runs at most ONE
long-running harness session at a time. The supervisor's
`killAndConfirm(handle)` is necessarily process- (or pod-, or
unit-) scoped; if multiple long-running sessions shared a worker,
reclaiming one stale session would terminate every other active
session in that worker, causing cross-session data loss. Hosts
deploying this package MUST run each long-running harness in a
dedicated worker (a dedicated `@koi/daemon` worker process, a
dedicated pod, a dedicated systemd unit). Multi-session-per-worker
deployments are explicitly out of scope; if they are needed
later, the supervisor contract will need a session-scoped kill
primitive (out of scope for this PR's 500-LOC budget). Reviewers
SHOULD reject configurations that violate the one-session
invariant.

**Non-reusability requirement.** `WorkerHandle` MUST include a
non-reusable identity component so that probe/kill cannot target a
reused OS identifier. Bare PIDs are NOT acceptable (PIDs are
reused; a PID file alone can point at an unrelated later process).
Acceptable composites:
- `@koi/daemon`: PID + Linux/macOS process start time (or
  Linux boot ID) read from `/proc/<pid>/stat` or `kinfo_proc`. The
  supervisor MUST validate the start time on every `probeAlive` /
  `killAndConfirm` and treat a mismatch as `"dead"` (the original
  worker is gone; whatever inhabits the PID now is unrelated).
- Kubernetes: pod UID (immutable across pod restarts of the same
  name within a namespace).
- launchd/systemd: invocation ID / generation ID, which the
  service manager regenerates on every unit start.

Implementations that cannot guarantee non-reuse (e.g., a plain
PID-file with no start-time validation) MUST NOT be used as the
`Supervisor` for this package.

`SessionRecord` gains `workerHandle: WorkerHandle | undefined` (set
during activation, before the harness `active` snapshot is published;
written via `saveSession`). Activation is atomic on the harness-side:
if the supervisor cannot mint a handle, activation aborts before any
snapshot CAS and no orphan worker exists. Uniqueness, persistence,
and restart behavior are supervisor-defined — the contract is that
two `WorkerHandle` values produced by the same supervisor at any
point in time identify two distinct workers, and a handle remains
addressable across supervisor restarts.

**The harness makes the supervisor requirement enforceable via an explicit
`Supervisor` config interface:**

```ts
interface Supervisor {
  /**
   * Mint a fresh worker handle for the worker that will run this
   * session. Called during activation BEFORE the harness publishes
   * the active snapshot. Persisted onto SessionRecord.workerHandle.
   * Failure aborts activation with SUPERVISOR_UNHEALTHY.
   */
  readonly mintWorkerHandle: (sessionId: string) =>
    Promise<Result<WorkerHandle, KoiError>>;

  /**
   * Non-destructive liveness probe keyed by the durable worker
   * handle. Implementations:
   *  - @koi/daemon: kill -0 on the PID; check process table.
   *  - kubectl: read pod.status.phase by pod UID.
   *  - launchd/systemd: query unit ActiveState by unit name.
   *
   * "alive"  — worker is running.
   * "dead"   — worker is confirmed exited / not in process table.
   * "unknown" — supervisor cannot determine state right now (transient
   *             query failure). Caller must NOT treat as dead.
   */
  readonly probeAlive: (handle: WorkerHandle) =>
    Promise<Result<"alive" | "dead" | "unknown", KoiError>>;

  /**
   * Forcibly terminate the worker identified by the given handle and
   * return only after termination is confirmed. Implementations:
   *  - @koi/daemon: SIGKILL the worker PID, await its exit code.
   *  - kubectl: delete the pod, await pod phase === "Failed".
   *  - launchd/systemd: stop the unit, await inactive.
   *
   * Idempotent: on an already-dead worker returns Ok.
   * Returns Err(KILL_FAILED) only if the supervisor itself is unhealthy.
   */
  readonly killAndConfirm: (handle: WorkerHandle) =>
    Promise<Result<void, KoiError>>;
}
```

**Reclaim probe-then-kill protocol.** Reclaim resolves the worker
handle via `loadSession(prev.lastSessionId).workerHandle` first. If
the session record is missing the handle (legacy data, activation
crash before handle persistence), or the session record itself is
missing for the entire orphan-detection window, reclaim returns
`Err(WORKER_HANDLE_MISSING, retryable: false)` — there is no safe
automatic takeover without the durable supervisor identity, so the
package never falls back to a sessionId-based kill. Recovery in
these cases requires an out-of-band administrative path
(`forceReclaim(sid, manualHandle)` or operator-supplied handle);
this is the SINGLE rule for missing-handle and missing-session
across all reclaim branches (probe-then-kill, orphan-detection,
trustedSingleProcess outcome-replay). Before any reclaim path
issues a destructive
`killAndConfirm`, it MUST first call `probeAlive(handle)`. The
**TTL-stale-but-alive case** (e.g., host sleep, VM suspension, long
GC pause) is the precise scenario this design must solve, so
process-existence is NOT proof of health: the heartbeat IS the
health signal, and a double-confirmed-stale heartbeat plus the
supervisor's own confirmation that the worker still exists is the
trigger for kill-on-takeover.

- `probeAlive === "alive"` AND heartbeat fresh (no double-confirmed
  staleness) → return `Err(RECLAIM_LIVE_OWNER, retryable: true)`.
  Owner is healthy; back off.
- `probeAlive === "alive"` AND **double-confirmed heartbeat-stale**
  (per the resume reclamation check) → **stalled-but-alive
  takeover.** Issue `killAndConfirm(handle)` to interrupt the
  stalled process so it cannot wake and emit side effects after a
  peer takes over, then CAS-advance. This is the load-bearing
  takeover path the supervisor requirement exists to enable.
- `probeAlive === "dead"` → proceed to `killAndConfirm` (idempotent
  no-op) then CAS-advance.
- `probeAlive === "unknown"` (any duration) → return
  `Err(SUPERVISOR_UNHEALTHY, retryable: true)`. We never escalate
  from `"unknown"` to `killAndConfirm`. `"unknown"` means the
  supervisor cannot determine liveness; pairing it with a
  stale-heartbeat read does not make the kill safe — under
  session-persistence lag or a read partition a healthy worker
  can look heartbeat-stale while the supervisor is temporarily
  unable to answer. The retryable error puts the takeover on the
  caller's clock; if the supervisor recovers, the next retry sees
  a positive `"alive"` or `"dead"` answer. If the supervisor
  remains unhealthy, operator action via the `forceReclaim`
  `manualHandle` path is the documented escalation.
- `probeAlive` returns `Err(IO_ERROR)` → return
  `Err(SUPERVISOR_UNHEALTHY, retryable: true)`. Never kill on a
  failed probe.

`LongRunningConfig` accepts `supervisor?: Supervisor`. The reclaim path is
gated on its presence:

- If `config.supervisor` is defined: reclaim resolves
  `handle = loadSession(prev.lastSessionId).workerHandle` and invokes
  `supervisor.killAndConfirm(handle)` BEFORE the CAS advance to
  `suspended`. If `workerHandle` is undefined (legacy data,
  pre-prereq session, or activation crash before handle was
  persisted), the harness MUST NOT silently fall back to a sessionId
  kill — it returns `Err(WORKER_HANDLE_MISSING, retryable: false)`
  and surfaces the session id for explicit operator-driven recovery
  (an out-of-band `forceReclaim(sid, manualHandle)` admin call is
  the documented recovery path; not part of the 500-LOC core). A
  kill failure aborts reclaim with `KILL_FAILED` (retryable); the CAS
  is not attempted.
- If `config.supervisor` is absent AND `config.trustedSingleProcess !==
  true`: `createLongRunningHarness` returns
  `KoiError { code: "INVALID_CONFIG", message: "either supervisor or
  trustedSingleProcess must be set" }`.
- If `config.trustedSingleProcess === true`: the harness refuses
  ALL automatic reclaim of any `active` snapshot on `resume()` —
  including outcome replay. The presence of a `RecoveryOutcome`
  alone is NOT proof the prior worker is dead (the outcome is
  written BEFORE kill on the ABORT_TIMEOUT path, and no supervisor
  is available to verify that the host's SIGKILL actually fired).
  Auto-replay in this mode would create split-brain risk: the prior
  process could still be alive and emitting side effects when the
  next resume CAS-advances the chain. Instead, recovery requires
  an explicit operator-confirmed step: `forceReclaim(sid,
  hostConfirmedDead: true)`. The operator asserts (out of band)
  that the host has been SIGKILLed and the prior process is gone;
  the admin call writes a durable host-confirmed-dead marker and
  THEN replays any `RecoveryOutcome` (or, if none, CAS-advances to
  `suspended` with `OPERATOR_FORCED`). On a fresh `resume()` with
  the marker present, the chain is already past `active` and
  resume proceeds normally. This is the documented availability
  tradeoff for trusted mode: the gain is an unforgeable "dead
  worker" assertion; the cost is one operator step.

There is no automatic orphan-record recovery path. Sustained
`NOT_FOUND` on `loadSession(prev.lastSessionId)` means no durable
`workerHandle` is recoverable, and the package never falls back to
sessionId-based kills. Recovery for that case requires the operator
`forceReclaim(sid, manualHandle)` admin path described above.

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
export { forceReclaim } from "./admin.js";
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
  ForceReclaimInput,
  ForceReclaimResult,
} from "./types.js";
export { DEFAULT_LONG_RUNNING_CONFIG } from "./types.js";
```

### `forceReclaim` (admin recovery API)

`forceReclaim` is the operator-driven recovery entry point for cases
where automatic reclaim is forbidden:
- `WORKER_HANDLE_MISSING` (legacy session with no durable handle, or
  session record itself missing across the orphan window).
- `trustedSingleProcess=true` after the host has externally SIGKILLed
  the prior worker.

```ts
interface ForceReclaimInput {
  readonly harnessStore: HarnessSnapshotStore;
  readonly sessionPersistence: SessionPersistence;
  readonly harnessId: HarnessId;     // identifies the snapshot chain
  readonly sessionId: SessionId;     // the session being reclaimed
  /**
   * One of:
   *  - { kind: "manualHandle", handle: WorkerHandle, supervisor: Supervisor }
   *      Operator supplies a handle they have validated out of band; the
   *      supervisor performs probe-then-kill against it before any CAS.
   *  - { kind: "hostConfirmedDead" }
   *      Operator asserts the prior process is dead. Writes a durable
   *      host-confirmed-dead marker before any CAS. Used in
   *      trustedSingleProcess mode.
   */
  readonly evidence:
    | {
        readonly kind: "manualHandle";
        readonly handle: WorkerHandle;
        readonly supervisor: Supervisor;
        // Required ONLY for the no-binding cases (session record
        // missing the workerHandle, or session record itself absent).
        // When set, the durable handle-equality check is skipped and
        // fencing falls back to (harnessId, sessionId, phase==="active").
        // The override is logged in audit trail.
        readonly override?: boolean;
      }
    | { readonly kind: "hostConfirmedDead" };
}

type ForceReclaimResult = Result<
  | { readonly kind: "replayed"; readonly outcome: RecoveryOutcomeKind }
  | { readonly kind: "advanced"; readonly newPhase: "suspended" }
  | { readonly kind: "noop"; readonly currentPhase: HarnessPhase },
  KoiError
>;

function forceReclaim(input: ForceReclaimInput): Promise<ForceReclaimResult>;
```

Behavior:
1. Read `harnessStore.latest(harnessId)` (the chain identifier comes
   from `ForceReclaimInput`, not from a reverse `sessionId →
   chainId` lookup which L0 does not provide). The caller is
   expected to know both IDs from the diagnostic state that
   prompted recovery (`HarnessStatus`, the original `start()` /
   `resume()` result, or operator records). If `prev.phase` is not
   `active`, return `Ok({ kind: "noop", currentPhase: prev.phase })`.
1a. **Session-id fencing (mandatory).** Reject the call with
   `Err(STALE_SESSION, retryable: false)` if `prev.lastSessionId !==
   input.sessionId`. forceReclaim is bound to the CURRENT active
   session; a mistyped or stale (harnessId, sessionId) pair must
   not be allowed to kill an unrelated worker or replay outcomes
   from a different session.

   For `manualHandle` evidence, the binding check depends on which
   missing-handle case is being recovered:
   - **Session record exists with a workerHandle:** require
     `loadSession(prev.lastSessionId).workerHandle ===
     input.evidence.handle`. Mismatch → `Err(STALE_SESSION)`. The
     operator cannot supply an unrelated handle.
   - **Session record exists but workerHandle is undefined**
     (legacy data, activation crash before persistence): the
     operator-supplied handle is the only available authority. The
     evidence MUST set `override: true` (see below) to acknowledge
     the binding cannot be cryptographically verified; without
     `override` the call returns `Err(WORKER_HANDLE_MISSING)`.
   - **Session record itself is missing** (sustained NOT_FOUND
     orphan): same as the no-workerHandle case — `override: true`
     is required. The harness verifies fencing via
     `(harnessId, prev.lastSessionId, prev.phase === "active")`
     instead of the durable handle binding. The operator's
     attestation is the recovery authority.

   `ForceReclaimInput.evidence` for `manualHandle` therefore is:
   `{ kind: "manualHandle"; handle: WorkerHandle; supervisor: Supervisor; override?: boolean }`.
   `override: true` is required ONLY for the no-binding cases; the
   admin API logs the override prominently so it appears in audit
   trails. With `override`, forceReclaim still runs probe-then-kill
   against the supplied handle (so an operator who supplies a
   visibly-live worker still gets `RECLAIM_LIVE_OWNER`); the
   override only relaxes the durable-binding requirement, not the
   live-fence safety check.
1b. **Mode fencing.** `hostConfirmedDead` evidence is ONLY accepted
   for harnesses configured with `trustedSingleProcess === true`.
   `manualHandle` evidence is ONLY accepted for harnesses with a
   `Supervisor`. The harness mode is recorded on the
   `HarnessSnapshot` (new `mode: "supervised" | "trustedSingleProcess"`
   field — added to the L0 prereqs) so forceReclaim can read it
   alongside `prev`. Wrong-mode evidence returns
   `Err(INVALID_CONFIG, retryable: false)`.
2. For `manualHandle` evidence: run the supervisor probe-then-kill
   protocol against the supplied handle. Live owner →
   `Err(RECLAIM_LIVE_OWNER)`; kill failure → `Err(KILL_FAILED)`.
3. For `hostConfirmedDead` evidence: write a durable
   host-confirmed-dead marker on the session record
   (`SessionPersistence.markHostConfirmedDead(sid)` — idempotent;
   re-marking is a no-op). The marker is the durable resumption
   point: even if the admin process crashes after this write but
   before step 4, a later `forceReclaim(harnessId, sid,
   { kind: "hostConfirmedDead" })` call observes the marker (idempotent
   write succeeds), then proceeds to step 4 against the still-`active`
   snapshot. The recovery is therefore retry-safe — running
   `forceReclaim` until it returns `Ok({ kind: "replayed" | "advanced" })`
   converges. `resume()` MUST treat the
   marker as advisory only: it is NOT permitted to advance the
   chain on its own based on the marker; only `forceReclaim`
   completes the transition. Resume in this state still returns
   `ALREADY_ACTIVE`, with the addition that the error context
   includes a `recoveryAvailable: "forceReclaim-hostConfirmedDead"`
   hint so operators are directed back to the admin path.
4. Then `listRecoveryOutcomes(sid)`:
   - One record → CAS-replay; return `Ok({ kind: "replayed", outcome: record.kind })`.
   - No record → CAS-advance to `suspended` with
     `failureReason = "OPERATOR_FORCED"`; return
     `Ok({ kind: "advanced", newPhase: "suspended" })`.
   CAS failure at step 4 returns `Err(CHECKPOINT_WRITE_FAILED,
   retryable: true)` — operator retries the SAME `forceReclaim`
   call; the marker remains durable and idempotent.

This is the documented recovery entry point referenced by every
`WORKER_HANDLE_MISSING` and `trustedSingleProcess` path in this
spec; it is part of the package surface and ships in the same PR as
the rest of the public API.

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
        dies. The harness internally mints a **private cleanup
        authority** at lease-revocation time (step 2) that survives
        the public lease's revocation; this authority owns the
        outcome write, the CAS retry loop, and the background
        watcher. The public lease being gone does NOT mean no actor
        can complete the transition — the cleanup authority is the
        actor. If the outcome write itself fails, the cleanup
        authority retries 3 times inline; on sustained failure, the
        cleanup authority transfers to a background loop (15s
        exponential, 5min cap) that keeps retrying the outcome write
        AND, on success, the snapshot CAS. The public `pause()`
        return is `Err(CHECKPOINT_WRITE_FAILED, retryable: true)`
        WITHOUT stopping heartbeats — the operator's "retry" is
        observational (the background authority is already
        retrying); a fresh `pause(newLease, …)` after a successful
        `resume()` is the path forward if the operator wants a new
        attempt. A peer reclaimer (TTL-stale via supervisor kill) is
        the fallback if this process dies before the cleanup
        authority drives the outcome durable.
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
            `compareAndPut(harnessId, H, outcome.snapshotDelta)`; on success,
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
       `supervisor.killAndConfirm(workerHandle)` automatically after
       a fixed grace period (`abortKillGraceMs`, default 30s).
       **Ownership-of-recovery rule:** for `Supervisor`
       implementations whose `killAndConfirm` terminates the
       harness's own process (the typical case — `@koi/daemon`
       SIGKILLs the worker that contains the harness; `kubectl`
       deletes the pod the harness runs in; systemd stops the unit
       the harness runs in), the harness CANNOT perform the
       post-kill CAS itself, because the call returns only after the
       caller is dead. In these implementations the durable
       `RecoveryOutcome` written before kill is the entire recovery
       contract: any reclaimer that subsequently calls `resume()`
       (a peer process, a restart of the same supervisor, or the
       next operator-initiated resume) finds the outcome via
       `listRecoveryOutcomes` and CAS-applies it. The harness
       process is not expected to survive `killAndConfirm`.
       For supervisor implementations whose kill targets only a
       child engine subprocess and leaves the harness alive, the
       harness's private cleanup authority CAN run the post-kill
       CAS in-process — but the contract does not require it. If
       `killAndConfirm` itself fails (`KILL_FAILED`) AND the harness
       process is still alive, a background watcher polls + retries
       every `heartbeatIntervalMs` with backoff until success or
       process exit. Either way the durable outcome guarantees
       eventual recovery; this is not "deterministic inside the
       package contract" if the supervisor kills the harness, it is
       deterministic across the joint contract of the harness +
       supervisor + reclaimer.
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
this package use `SnapshotChainStore.compareAndPut(harnessId, expectedHead, next)`.**
Plain `put(...)` is NOT permitted for any path that advances harness state
(activation, pause, fail, soft checkpoint, reclaim, dispose). Non-CAS
writes cannot fence stale writers and would re-introduce split-brain
advancement.

```
1. Build next HarnessSnapshot in memory (immutable), including incremented
   generation (when appropriate) and current lease's sessionId.
2. harnessStore.compareAndPut(harnessId, expectedHead, next):
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

1. If a supervisor is configured, call
   `supervisor.mintWorkerHandle(sid)` to obtain `workerHandle`.
   Failure aborts activation with `SUPERVISOR_UNHEALTHY` (no
   snapshot advance, no orphan). In `trustedSingleProcess` mode,
   `workerHandle` is left undefined.
   Write a session record with `status = "starting"`,
   `lastHeartbeatAt = Date.now()`, and the minted `workerHandle`
   via `sessionPersistence.saveSession` **before** any harness
   snapshot advance. If this fails → abort with
   `CHECKPOINT_WRITE_FAILED`; harness head is unchanged, no orphan
   is possible.
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
     `orphanWindow`, the session record is genuinely missing —
     which means there is no `workerHandle` to address the prior
     worker. Per the single missing-handle rule above, this branch
     CANNOT proceed to automatic kill: return
     `Err(WORKER_HANDLE_MISSING, retryable: false)` and surface
     `prev.lastSessionId` so the operator can drive
     `forceReclaim(sid, manualHandle)` out of band. We never publish
     `failed` from NOT_FOUND evidence alone, and we never call
     `probeAlive` / `killAndConfirm` without a durable
     supervisor-minted handle. This is intentional: a no-handle
     orphan path that picked any synthetic identifier could fence
     the wrong worker.
     - Bounded recovery time for the supervised case where the
       handle is recoverable later: ≤ `orphanWindow` (after which
       the operator-driven path takes over).

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
3. To reclaim — strict ordering: **fence FIRST, replay SECOND.**
   `RecoveryOutcome` records are intentionally written BEFORE
   `killAndConfirm` on terminal/abort paths, so a live worker MAY
   coexist with a durable outcome. Replaying before fencing would
   advance the chain while the original process is still capable of
   emitting side effects.
   1. Run the supervisor probe-then-kill protocol against
      `loadSession(prev.lastSessionId).workerHandle`. Reclaim
      proceeds ONLY after `killAndConfirm` returns `Ok` (or the
      probe path positively determines the worker is dead). Missing
      handle → `WORKER_HANDLE_MISSING` (per single missing-handle
      rule). Live owner → `RECLAIM_LIVE_OWNER`. Kill failure →
      `KILL_FAILED`. None of these proceed to outcome replay.
   2. Only after the worker is positively fenced:
      `listRecoveryOutcomes(prev.lastSessionId)`.
      - If a record exists (at most one — RecoveryOutcome is
        harness-level only): CAS-replay it via the subsumption +
        identity-match algorithm above. The chain ends in
        `suspended`, `completed`, or `failed` per the record's
        `kind`. Reclamation ENDS — future `resume()` returns
        `TERMINAL` for terminal kinds, or starts a fresh session
        for `harness-suspended`.
      - If no record exists: CAS-advance `prev` → `next` with
        `phase = "suspended"`, `generation = prev.generation + 1`,
        `failureReason = "RECLAIMED_FROM_DEAD_OWNER"`. Re-enter
        resume flow.

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
middleware writes) take the `SessionLease` as an explicit argument. Before
every store write the harness performs the SAME normative check used
everywhere else in this spec: `activeLeases.has(lease) === true` (WeakSet
membership on the live capability) AND object identity against the harness's
internal current-lease pointer. The lease is an unforgeable runtime capability;
generation is incidental metadata, not the authorization signal. A
structurally-matching object (same `sessionId`/`generation` field values) that
is NOT the WeakSet member fails the check. Stale leases (timed-out sessions,
superseded runs, reclaimed runs) are rejected with
`KoiError { code: "STALE_SESSION", retryable: false }` and their writes are
never persisted. Generation may additionally be compared as a defense-in-depth
consistency check, but it MUST NOT be the sole authorization signal — that
would turn the lease from an opaque capability into a guessable token.

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
4. **On quiescence:** apply the canonical terminal flow shared
   with `pause` / `fail` / `completeTask`-terminal: build the next
   snapshot (target phase = `failed`,
   `failureReason = "TIMEOUT"`), persist a `harness-failed`
   `RecoveryOutcome` BEFORE the snapshot CAS, then
   `compareAndPut(harnessId, prev.head, next)`. On CAS failure,
   schedule the same background retry loop used for terminal
   failures; the durable outcome lets a peer reclaimer complete
   the transition if this process dies. Invoke `onFailed` only
   after the CAS lands. Direct CAS-without-outcome is forbidden:
   timeout is a terminal path and obeys the exactly-once durable
   terminal-state contract.
5. **On abort timeout (engine refuses to stop):** apply the canonical
   ABORT_TIMEOUT contract defined in the phase-machine "Abort
   timeout" branch (see "Phase Machine — Abort timeout" above). In
   summary, that contract specifies:
   - Do NOT advance to `failed` yet. Snapshot stays `active`,
     heartbeats keep running (harness is non-reclaimable).
   - `status().durability = "unhealthy"`,
     `markCleanupUnhealthy(sid, "ABORT_TIMEOUT")`,
     `onDurabilityLost(ABORT_TIMEOUT)` invoked.
   - **Supervisor mode:** harness writes the durable
     `RecoveryOutcome` (kind=`harness-failed`,
     reason=`"TIMEOUT"`) BEFORE invoking
     `supervisor.killAndConfirm(workerHandle)`. Per the canonical
     ownership rule (see phase-machine "Abort timeout" branch),
     for typical supervisor implementations that kill the harness's
     own process, the post-kill CAS is performed by a later
     reclaimer (peer process or restart `resume()` consuming the
     outcome) — NOT by the dying harness. Recovery is durable but
     reclaimer-driven. Only for the narrow case of supervisors that
     kill an engine subprocess while leaving the harness alive does
     the in-process private cleanup authority drive the CAS.
   - **`trustedSingleProcess=true` mode:** no supervisor available;
     host MUST SIGKILL. After SIGKILL, recovery requires the
     operator `forceReclaim(sid, hostConfirmedDead: true)` admin
     path — there is no automatic recovery from `resume()` in this
     mode.
   This is the SINGLE source of truth for ABORT_TIMEOUT across all
   callers (pause/fail/timeout/dispose). The dispose section's
   "background watcher" is the same reclaimer-driven outcome-replay
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
     - **Supervisor mode (default):** dispose follows the SAME
       durability protocol as pause: write a `harness-suspended`
       `RecoveryOutcome` BEFORE the snapshot CAS, then 4-try
       backoff (100/500/2500/12500ms). On CAS success, stop
       heartbeats, release store references, return
       `Ok({ kind: "disposed" })`. On 4-try exhaustion: keep
       heartbeats running, transition `durability = "unhealthy"`,
       durably call `markCleanupUnhealthy(sid,
       "DISPOSE_WRITE_FAILED")`, schedule the same background
       retry loop used for pause/terminal failures (15s
       exponential, 5min cap; CAS uses the durable outcome record's
       snapshotDelta). Public return is
       `Err(CHECKPOINT_WRITE_FAILED, retryable: true)` — NOT `Ok`.
       The host MUST treat this as "cleanup not yet durable" and
       can either retry `dispose()` (which observes the latched
       failure idempotently) or rely on the background authority
       plus peer reclaimer to drive convergence. The previous
       "stop heartbeats anyway and rely on TTL reclaim" semantics
       were unsafe because they returned `Ok` while the chain was
       still `active`; the new contract guarantees: callers seeing
       `Ok` ALWAYS see a durably `suspended` snapshot.
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
     - **Supervisor mode:** harness writes a durable
       `RecoveryOutcome` (kind=`harness-suspended`,
       reason=`"disposed after kill"`) BEFORE invoking
       `supervisor.killAndConfirm(workerHandle)`. Per the canonical
       ABORT_TIMEOUT ownership rule, the post-kill CAS is
       reclaimer-driven (peer or next `resume()`) when the
       supervisor kills the harness's own process; only for
       narrowly-scoped engine-subprocess kills does the in-process
       private cleanup authority drive the CAS in-process.
     - **`trustedSingleProcess=true` mode:** no supervisor; no
       automatic recovery. Operator must SIGKILL the host externally
       and then invoke `forceReclaim(sid, hostConfirmedDead: true)`
       to advance the chain to `suspended`.
     - **Idempotent return shape on retry:** the harness records the
       ABORT_TIMEOUT result on its internal state and returns the
       SAME stable result on every subsequent `dispose()` call until
       the cleanup authority succeeds (or process exit). Repeated
       calls do NOT re-issue `killAndConfirm`, do NOT re-revoke any
       lease, and do NOT advance any state — they observe the
       latched outcome. Once the cleanup authority finalizes
       (chain advanced to `suspended`), subsequent `dispose()` calls
       observe the now non-`active` phase and return
       `Ok(undefined)` per the step-3 short-circuit. This preserves
       the documented idempotency contract: identical inputs produce
       identical outputs across retries; the only state change is
       driven by the cleanup authority asynchronously, not by
       repeated calls.

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
   `lease.generation`, call `harnessStore.compareAndPut(harnessId, expectedHead, next)`.
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
- **Orphan session record (no handle available):** `loadSession`
  returns `NOT_FOUND` for the full orphan window, so no
  `workerHandle` is recoverable. Harness returns
  `Err(WORKER_HANDLE_MISSING, retryable: false)` — does NOT call
  `killAndConfirm`, does NOT publish any phase change. Recovery
  requires operator-driven `forceReclaim(sid, manualHandle)`.
  Regression against unsafe sessionId-based fences.
- **forceReclaim(manualHandle) + supervisor reports live owner:**
  operator invokes `forceReclaim(harnessId, sid, { kind:
  "manualHandle", handle, supervisor, override: true })` for an
  orphan-NOT_FOUND case. Supervisor returns `"alive"`. forceReclaim
  refuses with `Err(RECLAIM_LIVE_OWNER, retryable: true)` and does
  NOT advance state. Regression against killing a healthy worker
  during operator-override recovery.
- **forceReclaim(manualHandle) + supervisor unhealthy:** operator
  invokes the same path; supervisor returns `Err(KILL_FAILED)`.
  forceReclaim returns `Err(KILL_FAILED, retryable: true)`. Harness
  state unchanged.
  (These are explicit `forceReclaim` paths — automatic reclaim
  NEVER probes or kills without a durable handle binding.)
- **Transient NOT_FOUND (read replica lag):** first read returns
  `NOT_FOUND`, subsequent polls within `orphanWindow` see the actual
  record → orphan loop exits, reclamation re-runs with the visible
  record (TTL double-confirmation applies). No false orphan
  classification.
- **Stale heartbeat double-confirmation:** first read shows
  `lastHeartbeatAt > leaseTtlMs` but a `heartbeatIntervalMs * 2` wait
  then shows a fresh heartbeat → `ALREADY_ACTIVE`, no reclaim.
  Regression against stale-replica misclassification of live owners.
- **`trustedSingleProcess=true`, plain `resume()`:** on any
  `active` snapshot returns `ALREADY_ACTIVE` unconditionally — no
  generic TTL reclaim, no automatic outcome replay, regardless of
  whether a `RecoveryOutcome` exists. Verified by test that asserts
  reclaim is never invoked from `resume()` in this mode.
- **`trustedSingleProcess=true`, operator-confirmed recovery:**
  operator calls `forceReclaim(sid, hostConfirmedDead: true)` after
  external SIGKILL of the prior process. The admin call writes a
  durable host-confirmed-dead marker, then CAS-replays any
  `RecoveryOutcome` (terminal → chain ends in `completed`/`failed`;
  `harness-suspended` → chain advanced to `suspended` and a fresh
  `resume()` can start a new session) or, if no outcome exists,
  CAS-advances to `suspended` with `OPERATOR_FORCED`. Verified by
  test that asserts the marker is required and resume() with no
  marker still returns `ALREADY_ACTIVE`.
- **`createLongRunningHarness` rejects missing supervisor:** config
  without `supervisor` AND without `trustedSingleProcess=true` returns
  `INVALID_CONFIG` at construction time.
- **Supervisor kill before reclaim (TTL path):** double-confirmed stale
  heartbeat → harness calls `supervisor.killAndConfirm(workerHandle)`
  BEFORE CAS → kill succeeds → CAS advances. Mock supervisor asserts
  ordering.
- **Sustained NOT_FOUND orphan (no handle):** orphan-window elapses
  with NOT_FOUND → harness returns
  `Err(WORKER_HANDLE_MISSING, retryable: false)` and does NOT call
  `killAndConfirm` or CAS. Recovery requires
  `forceReclaim(sid, manualHandle)` operator path. Regression
  against unsafe sessionId-based fences and against the deleted
  ORPHAN_RECOVERED auto-path.
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
| `WORKER_HANDLE_MISSING` | session record missing the durable `workerHandle` (or session record itself missing across the orphan window); reclaim hard-stops, no automatic kill or CAS — operator must use `forceReclaim(sid, manualHandle)` | false |
| `OPERATOR_FORCED` | `forceReclaim` admin path used to advance an `active` snapshot to `suspended` after operator-confirmed dead worker (trustedSingleProcess or no-handle paths) | true |
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
       chainId: ChainId,                       // chain target (mandatory)
       expected: ChainHead | undefined,        // undefined = chain empty
       next: T,
     ) => Promise<Result<{ readonly head: ChainHead }, KoiError>>
        | Result<...>;
     // compareAndPut error codes include:
     //   CAS_MISMATCH (expected != current head; head returned)
     //   IO_ERROR (store unhealthy)
   }
   ```

   `chainId` is mandatory on every `compareAndPut`. It both
   identifies which chain to update under contention AND
   disambiguates the empty-chain case (`expected === undefined`)
   for chain creation. `ChainHead` carries position only; chain
   identity always comes from the explicit `chainId` argument.

   The spec uses `latest(chainId)` and `compareAndPut(chainId,
   prev.head, next)` throughout — both must exist in L0 before
   implementation. Existing `put()` remains for non-advancing
   writes (e.g. recording orphan snapshots during reconciliation).

**`@koi/core` — `SessionRecord`/`SessionStatus`/`SessionPersistence`
(session.ts):**
3. `SessionRecord.lastHeartbeatAt: number | undefined` — liveness signal.
3a. `SessionRecord.workerHandle: WorkerHandle | undefined` — durable
   supervisor-minted worker identity. Persisted at activation
   (BEFORE the harness `active` snapshot is published) so peer
   reclaimers can call `probeAlive`/`killAndConfirm` against the
   correct worker after process or supervisor restarts.
   `WorkerHandle` is an opaque string supervisor-side; the contract
   says two distinct values identify two distinct workers and a
   handle remains addressable across supervisor restarts.
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

9. `SessionPersistence.markHostConfirmedDead(sid)` — DURABLE
   one-shot marker written by the `forceReclaim(harnessId, sid,
   { kind: "hostConfirmedDead" })` admin path. The marker is
   idempotent (re-marking is a no-op) and intentionally one-way
   (cleared only when the session record is removed). The marker
   is consumed ONLY by `forceReclaim` (advisory to `resume()`).
   `resume()` MUST NOT advance the chain based on the marker
   alone — it returns `ALREADY_ACTIVE` even when the marker is
   present, and includes a `recoveryAvailable:
   "forceReclaim-hostConfirmedDead"` hint in the error context so
   operators are directed to the admin path. This is the canonical
   semantics: the only path that uses the marker to advance state
   is `forceReclaim`. The marker exists so that a crashed/retried
   `forceReclaim` is idempotent and converges on retry.

10a. `KoiErrorCode` union additions (errors.ts). The current
   exhaustive union does not include the codes this design uses.
   Add these to the union as part of the L0 migration; downstream
   exhaustive switches and tests must be updated:

   - `TERMINAL` (resume on completed/failed)
   - `INVALID_STATE` (illegal phase transition)
   - `ALREADY_ACTIVE` (concurrent resume against a live owner)
   - `CONCURRENT_RESUME` (lost CAS to a peer activation)
   - `STALE_SESSION` (revoked / superseded lease, or
     forceReclaim sessionId mismatch)
   - `CHECKPOINT_WRITE_FAILED` (CAS failed after retries)
   - `HEARTBEAT_STALE` (heartbeat-write nearing TTL)
   - `ABORT_TIMEOUT` (engine ignored abort)
   - `INVALID_CONFIG` (config invariant violation;
     wrong-mode forceReclaim evidence)
   - `ACTIVATION_STATUS_WRITE_FAILED` (warning, returned in
     StartResult, not as Err)
   - `RECLAIM_READ_FAILED` (loadSession I/O after retries)
   - `KILL_FAILED` (supervisor.killAndConfirm failed)
   - `RECLAIM_LIVE_OWNER` (live owner detected; back off)
   - `SUPERVISOR_UNHEALTHY` (probeAlive IO_ERROR or "unknown")
   - `REPLAY_AUTHORITY_MISMATCH` (RecoveryOutcome predecessor
     not subsumed and not equal to current head)
   - `RESUME_CORRUPT` (snapshot fails isHarnessSnapshot)
   - `WORKER_HANDLE_MISSING` (no durable handle / no session
     record; operator forceReclaim required)
   - `OPERATOR_FORCED` (informational on advance via
     forceReclaim with no RecoveryOutcome)
   - `PAUSE_WRITE_FAILED` / `DISPOSE_WRITE_FAILED` /
     `TERMINAL_WRITE_FAILED` (cleanup-health reasons; carried
     in error.context, not separate codes — but listed here for
     completeness so reviewers know they map to
     `CHECKPOINT_WRITE_FAILED` with a structured `reason` field)
   - `DISPOSE_STORE_UNREACHABLE` (dispose deadline elapsed in
     trustedSingleProcess background retry)
   - `RECLAIM_LIVE_OWNER` (already listed)

   The L2 package MUST NOT silently overload existing codes
   (`NOT_FOUND`, `CONFLICT`, etc.) for these states — each row
   above is a distinct callsite-observable condition.

10. `HarnessSnapshot.mode: "supervised" | "trustedSingleProcess"`
   — recorded at activation so `forceReclaim` can mode-fence
   evidence (`hostConfirmedDead` only for trusted mode;
   `manualHandle` only for supervised). Mode is immutable per
   harness; it is set from `LongRunningConfig` at the first
   `start()` and preserved across resumes.

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
