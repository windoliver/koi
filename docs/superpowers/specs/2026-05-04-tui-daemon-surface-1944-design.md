# TUI Daemon Surface (#1944)

**Branch:** `feat/tui-daemon-surface-1944`
**Issue:** [#1944](https://github.com/windoliver/koi/issues/1944) — v2 Phase 3b-8: TUI daemon surface
**Status:** Design approved, ready for implementation plan

## Summary

Surface the `@koi/daemon` subsystem in `@koi/tui`. Today the daemon ships
supervisors, session registries, and heartbeat health, but a TUI user spawning
a **subprocess-isolated** subagent sees nothing about supervision — no crash
recovery signal, no isolation visibility, no health insight. This PR makes
the OS-process supervision path observable. In-process supervision continues
to surface via the existing `/agents` Supervised section; see "Scope
clarification" below.

## Scope

Single PR. Two halves:

### Half A — Runtime wiring (prerequisite)

Issue #1866 closed with an in-process stub (`wire-manifest-supervision.ts`).
The actual `@koi/daemon` `Supervisor` is never instantiated in production.
Per the doc comment in that file, end-to-end activation was deferred to #1944.
This PR completes it.

- Instantiate `createSupervisor` (`@koi/net/daemon`) in the CLI bootstrap when
  loaded manifest declares `supervision:` with at least one child whose
  `isolation === "subprocess"`.
- Wire `attachRegistry` to a `createFileSessionRegistry({ dir })` so
  `koi bg ps/logs/kill` becomes useful in tandem.
- Expose the supervisor handle from the CLI bootstrap so the daemon-bridge
  (Half B) can subscribe to it. TUI itself never holds the handle.
- In-process-only manifests (no subprocess children) skip daemon
  instantiation — the existing in-memory `AgentRegistry` wiring continues
  to drive the `/agents` Supervised section.

**Scope clarification — what the new surfaces cover:**

| Manifest shape | Status-line badge | Toasts | `/supervisor` | `/bg` | Inline events | `/agents` |
|----------------|:-:|:-:|:-:|:-:|:-:|:-:|
| No `supervision:` | hidden | — | empty state | empty state | — | unchanged |
| `supervision:` with subprocess child | ✅ | ✅ | ✅ | ✅ | ✅ | unchanged |
| `supervision:` in-process only | hidden | — | empty state | empty state | — | shows children (existing) |

The new surfaces are explicitly the **OS-process supervision** UX. They
require a live `@koi/net/daemon` Supervisor with subprocess-backed workers
to have anything to render — heartbeat, PID, log path, backend kind, and
crash semantics are OS-process concepts. In-process supervision continues
to surface through the existing `/agents` Supervised section (#1866). A
future issue can unify both paths if/when in-process workers grow
heartbeat semantics; today they don't and conflating the two would mean
inventing fake telemetry.

### Half B — TUI surface

Six features per the issue:

1. **Status-line indicator** — supervisor health badge + worker counts on
   right side of `StatusBar.tsx`. Hidden when no supervisor attached.
2. **Alert toasts** — toasts triggered by signals the public API actually
   exposes:
   - `WorkerEvent.crashed` (push, from `watchAll()`).
   - `WorkerSnapshot.state === "quarantined"` transition (derived from
     `health()` polls — the L0 `WorkerEvent` union does not include a
     `quarantined` push event today; we infer the transition by diffing
     consecutive health snapshots).
   - `WorkerSnapshot.state === "restarting"` transition (same derivation).
   - `health().status` ok→degraded / ok→unhealthy.
   Dedup per `(workerId, signalKind)` with TTL 30s.
3. **`/supervisor`** — full-screen, read-only: health + reasons, worker
   table, last-50 event feed, backend kinds. Mutation actions deferred.
4. **`/bg`** — full-screen: `FileSessionRegistry.list()` merged with live
   health, freshness badge per row, `Enter` tails logs in-TUI, `k` triggers
   kill confirm prompt that routes through the bridge.
5. **Spawn tool output enrichment** — show `workerId`, isolation mode,
   backend kind on Spawn tool result rendering.
6. **Session log inline events** — supervisor signals rendered inline in
   the session log with the subagent name. Only signals the public API
   surfaces today:
   - `WorkerEvent.started` (push)
   - `WorkerEvent.exited` (push) — with `code` + `state`
   - `WorkerEvent.crashed` (push) — with `error.message`
   - **Inferred** `restarting` and `quarantined` from health-snapshot
     diffs (derived state, marked clearly in the feed entry as derived
     so operators don't mistake it for a discrete event timestamp).
   No "stopped" entry — the L0 event union models stop as `exited`.

## Architecture

```
                    Manifest declares supervision: with subprocess isolation
                                          │
                                          ▼
  CLI bootstrap (packages/meta/cli/src/) ─── instantiates ───┐
                                          │                  │
                                          ▼                  ▼
                            createSupervisor          createFileSessionRegistry
                            (@koi/net/daemon)          (@koi/net/daemon)
                                          │                  │
                                          └─── attachRegistry ┘
                                          │
                                          ▼
                  daemon-bridge.ts (NEW, packages/meta/cli/src/)
                                          │
                  ┌───────────────────────┼───────────────────────┐
                  │                       │                       │
            supervisor.events()   supervisor.health()    registry.list()
            (subscribe)              (poll 1s)             (poll 1s)
                  │                       │                       │
                  ▼                       ▼                       ▼
                          TuiStore dispatches
              ─────────────────────────────────────────────
              push_supervisor_event   set_supervisor_health
              set_bg_rows             push_toast (deduped)

                  ▲                                       │
                  │ requestKill(sessionId)                │
                  │                                       ▼
            onCommand("system:bg-kill")          TUI views render
            handler in tui-root                  StatusBar / SupervisorView /
                                                 BgView / Toast
```

### Layer compliance

- **L0** types (`Supervisor`, `WorkerEvent`, `SupervisorHealth`,
  `WorkerSnapshot`, `BackgroundSessionRegistry`) already live in
  `@koi/core/daemon` — TUI imports types only, no L2-on-L2 dependency.
- **L2 `@koi/tui`** holds state slices + view components. No runtime handles.
- **L3 `@koi/meta-cli`** owns the bridge and instantiation. Already imports
  `@koi/net/daemon` (verified — file `daemon-spawn-child-fn.ts` referenced).
- **One interposition layer** preserved — bridge uses public Supervisor API
  (`events()`, `health()`, `list()`, `stop()`); no new hooks.

## File Layout

```
packages/meta/cli/src/
  daemon-bridge.ts                  NEW  ~220 LOC
                                         Subscribes events; polls health +
                                         registry; dispatches into store;
                                         exposes onCommand handler.
  wire-daemon-supervisor.ts         NEW  ~180 LOC
                                         Composes createSupervisor +
                                         createFileSessionRegistry +
                                         attachRegistry. Returns handle +
                                         dispose. Skipped when no subprocess
                                         children declared.
  bin.ts                            EDIT  ~30 LOC
                                         Wire wireDaemonSupervisor +
                                         createDaemonBridge into the TUI
                                         startup path; dispose in graceful
                                         shutdown.

packages/ui/tui/src/
  state/types.ts                    EDIT  ~80 LOC
                                         Add SupervisorSlice, BgSessionsSlice,
                                         supervisor + bg view kinds, dispatch
                                         action discriminants.
  state/initial.ts                  EDIT  ~12 LOC
  state/reduce.ts                   EDIT  ~120 LOC
                                         Handle new actions; ring buffer cap
                                         50 for events; freshness compute.
  state/mutations.ts                EDIT  ~30 LOC
  components/StatusBar.tsx          EDIT  ~40 LOC
                                         Render badge ◎/◑/● + count after
                                         existing governance segment.
  components/SupervisorView.tsx     NEW  ~250 LOC
                                         Health header + reasons + worker
                                         table + event feed + backend list.
  components/BgView.tsx             NEW  ~280 LOC
                                         Row table + freshness color +
                                         confirm modal + tail pane mount.
  components/BgLogTail.tsx          NEW   ~80 LOC
                                         fs.watch + initial tail-N read +
                                         component-local ring buffer.
  tui-root.tsx                      EDIT  ~50 LOC
                                         View dispatch for "/supervisor",
                                         "/bg"; "system:bg-kill" routing;
                                         tail key handling.
  commands/command-definitions.ts   EDIT  ~25 LOC
                                         Register /supervisor, /bg,
                                         system:bg-kill.
  tool-display.ts                   EDIT  ~40 LOC
                                         Spawn tool result enrichment.

Tests
  packages/meta/cli/src/daemon-bridge.test.ts                NEW
  packages/meta/cli/src/wire-daemon-supervisor.test.ts       NEW
  packages/ui/tui/src/state/reduce.test.ts                   EDIT
  packages/ui/tui/src/components/StatusBar.test.tsx          EDIT
  packages/ui/tui/src/components/SupervisorView.test.tsx     NEW
  packages/ui/tui/src/components/BgView.test.tsx             NEW
  packages/ui/tui/src/__tests__/daemon-tui-e2e.test.ts       NEW (gated)
```

**Total estimate:** ~1150 LOC (within CLAUDE.md's <1500 ceiling).

## State Slices

```typescript
// packages/ui/tui/src/state/types.ts (additions)

import type {
  SupervisorHealth,
  WorkerEvent,
  WorkerSnapshot,
  WorkerBackendKind,
} from "@koi/core/daemon";

const SUPERVISOR_EVENT_BUFFER_CAP = 50;

/**
 * Per-channel liveness tracked independently. Composite UI status is
 * derived from the worst dimension — never optimistic.
 */
interface ChannelLiveness {
  readonly health: "live" | "stale";       // supervisor.health() poll
  readonly registryList: "live" | "stale"; // registry.list() poll
  readonly workerEvents: "live" | "stale"; // supervisor.watchAll() iter
  readonly registryEvents: "live" | "stale"; // registry.watch() iter
}

/**
 * UI surface status — derived from ChannelLiveness, never set directly:
 *
 *   detached  ⇔ no supervisor attached this session
 *   live      ⇔ ALL four channels live
 *   degraded  ⇔ at least one push channel (workerEvents/registryEvents)
 *               stale, but polls live — surface still functions in
 *               poll-only mode; toasts/inline events lag or miss
 *   stale     ⇔ at least one poll channel stale — primary state may be
 *               wrong; preserve last snapshot, do not blink empty
 */
type BridgeStatus =
  | { readonly kind: "detached" }
  | { readonly kind: "live" }
  | { readonly kind: "degraded"; readonly missing: readonly ("workerEvents" | "registryEvents")[]; readonly since: number }
  | { readonly kind: "stale"; readonly since: number; readonly reason: string };

interface SupervisorSlice {
  readonly attached: boolean;       // false ⇔ status.kind === "detached"
  readonly status: BridgeStatus;    // distinguishes detached from unavailable
  readonly health: SupervisorHealth | null;  // last-known; not cleared on failure
  readonly events: readonly SupervisorEventEntry[];
}

interface SupervisorEventEntry {
  readonly id: string;
  readonly ts: number;
  readonly kind: WorkerEvent["kind"];
  readonly workerId: string;
  readonly agentName: string;
  readonly detail?: string;
}

/**
 * Mirrors `BackgroundSessionRecord` from `@koi/core/daemon` 1:1 — never
 * narrows `BackgroundSessionStatus`. Coercing `terminating` or `detached`
 * into `running`/`exited` would lose the operator-visible "kill in flight"
 * and "detached but live" signals that operators rely on to recover from
 * stranded kills and tmux reattachments.
 *
 * Row identity is `workerId` (the registry's primary key). The optional
 * `sessionId` from the record is carried through for display + filter only.
 */
interface BgSessionRow {
  readonly workerId: string;          // registry primary key
  readonly agentId: string;
  readonly sessionId: string | null;  // optional logical id from record
  readonly status: BackgroundSessionStatus;  // FULL union, no narrowing
  readonly pid: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
  readonly lastHeartbeatAt: number | null;
  readonly heartbeatDeadlineAt: number | null;
  readonly logPath: string;
  readonly backendKind: WorkerBackendKind;
  readonly version: number;           // for respawn-race detection on kill
  readonly signaledAt: number | null; // operator kill intent marker
  /**
   * `pending`     — heartbeat opt-in, no heartbeat yet, within grace.
   * `ok`          — heartbeat opt-in, heartbeat received within deadline.
   * `stale`       — heartbeat opt-in, heartbeat older than deadline.
   * `timeout`     — heartbeat opt-in, heartbeat past 2× deadline interval.
   * `unmonitored` — heartbeat NOT opted in (permanent: heartbeat fields
   *                 absent from the supervisor's published health snapshot).
   *                 Renders neutral. NEVER colored as a failure — absence
   *                 of heartbeat ≠ unhealthy.
   * `terminating` — record status is `terminating`; yellow "kill in
   *                 flight" with `signaledAt` age.
   * `detached`    — record status is `detached`; freshness neutral.
   * `terminal`    — record status is `exited` or `crashed`; freshness off.
   */
  readonly freshness:
    | "pending"
    | "ok"
    | "stale"
    | "timeout"
    | "unmonitored"
    | "terminating"
    | "detached"
    | "terminal";
}

interface BgSessionsSlice {
  readonly rows: readonly BgSessionRow[];
  /** workerId of the row whose log is being tailed. */
  readonly tailingWorkerId: string | null;
  /** workerId + version of the row pending kill confirmation. */
  readonly killConfirm:
    | { readonly workerId: string; readonly version: number; readonly pid: number }
    | null;
}
```

Dispatch actions:

- `set_supervisor_attached: { attached: boolean }`
- `set_supervisor_status: { status: BridgeStatus }`
- `set_supervisor_health: { health: SupervisorHealth | null }`
- `push_supervisor_event: { entry: SupervisorEventEntry }` (caps buffer)
- `clear_supervisor_events`
- `set_bg_rows: { rows: readonly BgSessionRow[] }`
- `set_bg_tailing: { workerId: string | null }`
- `set_bg_kill_confirm: { confirm: { workerId: string; version: number; pid: number } | null }`

Toasts reuse existing `push_toast` action — no new shape.

## Data Flow Details

### Bridge subscription + poll cadence

The actual `Supervisor` surface is:

- `supervisor.health(): SupervisorHealth` — **synchronous**, in-memory,
  no `await`. Pure read.
- `supervisor.watchAll(): AsyncIterable<WorkerEvent>` — infinite async
  generator. Consumers cancel via the **closed-sentinel race** pattern
  used by `attachRegistry` in
  `packages/net/daemon/src/registry-supervisor-bridge.ts` (see lines
  193–298). Calling `iter.return()` while parked does NOT resolve the
  pending await; we race each `next()` against a `closed` Promise that
  `bridge.close()` resolves.
- `registry.describeList(): Promise<Result<readonly BackgroundSessionRecord[], KoiError>>`
  — **strict** read; surfaces directory/permission/corruption faults as
  `Result.ok: false`. The bridge **must** use this and not the lenient
  `registry.describeList()`, which collapses errors to an empty array (`list()`
  is a CLI ergonomic for `koi bg ps`, not a liveness primitive).
- `registry.watch(): AsyncIterable<BackgroundSessionEvent>` — also
  available; we consume it with the same closed-sentinel pattern as a
  push channel for incremental updates between polls.

Cadence:

| Source | Method | Interval |
|--------|--------|----------|
| `supervisor.health()` | poll | 1s |
| `supervisor.watchAll()` | async iterable, closed-sentinel race | event-driven |
| `registry.describeList()` | poll for full table refresh | 1s (debounced if last call >250ms) |
| `registry.watch()` | async iterable, closed-sentinel race | event-driven, drives row patches between polls |

Polling `health()` keeps the badge fresh even when no events fire (worker
counts changing while quiet). Polling `list()` keeps `/bg` rows accurate
even if a `registry.watch()` consumer drops an event — defense in depth.

### Bridge ownership model

```typescript
interface DaemonBridge {
  readonly close: () => Promise<void>;
  readonly requestKill: (req: {
    readonly workerId: string;
    readonly expectedVersion: number;
    readonly expectedPid: number;
  }) => Promise<void>;
}
```

`close()` semantics (mirroring `attachRegistry`):

1. Set internal `closing = true`.
2. Resolve the `closed` sentinel Promise — both `watchAll` and
   `registry.watch` loops exit at their next `Promise.race` checkpoint.
3. Clear `setInterval` handles for `health` + `list` polls.
4. Wait (with deadline ≤ 2s) for both consumer loops' `done` promises.
5. Best-effort `iterator.return?.().catch(() => {})` on both iterables —
   never `await` (parked generators never settle on `return`).

`requestKill` rejects internal errors as toasts, never throws to caller.

All intervals + iterators stop on `close()`. **Shutdown ordering** is
the inverse of attach: terminal `stopped`/`exited` events are published
only once `supervisor.shutdown()` begins, so the bridge must remain
subscribed while shutdown is in flight, otherwise the final lifecycle
updates the bridge exists to surface are lost.

```
graceful shutdown sequence in bin.ts
  1. const shutdownTask = supervisor.shutdown(reason);  // start async
  2. await shutdownTask;                                // wait for terminal events to drain through watchAll
  3. await bridge.close();                              // closed-sentinel + iterator cleanup
  4. await registryBridge.close();                      // attachRegistry's own bridge
```

Step 3 happens after `shutdown()` resolves so `watchAll()` has already
emitted the final `stopped`/`exited` events through both registry and
TUI bridges. If steps are reversed, the bridge times out before
`supervisor.shutdown()` even begins publishing — exactly the regression
this surface should not introduce. A shared deadline (e.g., total 5s)
is enforced by wrapping step 2 in a timeout; on expiry, step 3 still
runs to release resources.

### Bridge failure handling

Every poll and the event subscription wrap their work in try/catch. The
bridge **never** silently clears state on failure; instead it preserves the
last-known snapshot and flags the surface as stale.

| Failure | Action |
|---------|--------|
| `health()` throws (synchronous read; rare — bug or torn snapshot) | Increment `healthFailureCount`. After 3 consecutive failures, dispatch `set_supervisor_status({ kind: "stale", since: firstFailureAt, reason })`. Keep `health` slice unchanged so the worker table does not blink empty. Log via existing logger. |
| `registry.describeList()` returns `Result.ok: false` OR throws | Same 3-strike → `stale` status; keep last `rows`. Toast once per stale transition: `"⚠ background session registry unavailable: ${err.message}"`. (Lenient `list()` is intentionally not used here — empty arrays would be indistinguishable from real outage.) |
| `watchAll()` iterator throws or ends `done: true` | Iterator pattern means a thrown error surfaces in the `for await` `catch`. Dispatch stale; **reacquire indefinitely** with capped exponential backoff `1s, 2s, 5s, 10s, 30s, 60s` (cap), each attempt jittered ±20% to avoid lockstep retry storms. While stream is down, `health()` + `registry.describeList()` polling continue (degraded poll-only mode); the surface remains functional, just without push events. |
| `registry.watch()` iterator throws or ends | Same indefinite-reacquire policy as `watchAll`. Independent counter — a flaky FS watcher does not cancel the supervisor stream. `registry.describeList()` polling backstops row freshness. |
| Recovery (any successful operation) | Reset that channel's failure counter; mark its `ChannelLiveness` slot back to `live`. **Recompute composite status from the full liveness map** — only flip back to `kind: "live"` when ALL four channels are live. If push channels are still down, status remains `degraded`. Toast on transitions: `"✓ supervisor stream restored"` when both push channels recover; `"✓ supervisor connection restored"` only on `degraded → live` or `stale → live` transitions. |
| `bridge.close()` during reconnect backoff | The closed-sentinel race exits the backoff sleep immediately; no leaked timers. |

The composite-status rule rules out a known anti-pattern: a flapping
`watchAll()` would otherwise keep the badge looking healthy while crash
toasts silently never fire. Push-channel outage is **always** at least
`degraded` — operators see `◐` plus a tooltip naming which streams are
out, never `◎`.

Status-line rendering uses `status.kind`:
- `detached` → segment hidden (current behavior).
- `live` → badge ◎/◑/● per `health.status`.
- `degraded` → badge `◐` plus tooltip listing missing push channels;
  worker counts still rendered from polled `health()`.
- `stale` → badge `◌` (open circle) plus `"stale Ns"` countdown — explicit
  signal that observability is broken, not that everything is healthy.

This rules out the failure mode where a dead bridge silently presents as
"no supervisor attached".

### Toast triggers (bridge maps WorkerEvent → toast)

| Trigger | Source | Message |
|---------|--------|---------|
| `WorkerEvent.crashed` | push | `⚠ worker <agentName> crashed: <error.message>` |
| `WorkerSnapshot.state` `*→quarantined` | health diff | `⚠ worker <agentName> quarantined after <restartCount> restarts` |
| `WorkerSnapshot.state` `running→restarting` | health diff | (info, not warning) `↻ worker <agentName> restarting` |
| `health.status` ok→degraded | health diff | `⚠ supervisor degraded: <first reason>` |
| `health.status` ok→unhealthy | health diff | `⚠ supervisor unhealthy: <first reason>` |

Dedup key: `${workerId}:${signalKind}`. TTL 30s. Reuses existing
governance dedup helper if extractable; otherwise a tiny local map.

Health-diff inference rule: bridge keeps the previous `SupervisorHealth`
snapshot in memory and computes per-worker state transitions on each
poll. A toast fires once per transition into `quarantined`/`restarting`,
not on every poll while in that state. If a worker disappears from the
snapshot between polls (e.g., quarantine → terminate), the bridge does
not synthesize a fake event — the next `WorkerEvent.exited`/`crashed`
push is authoritative.

### Freshness computation

Per row, at dispatch time (not render). The supervisor publishes
**per-worker** `lastHeartbeatAt` and `heartbeatDeadlineAt` on the
`SupervisorHealth.workers[]` snapshot — both are `number | undefined`.
There is **no** global `heartbeatDeadlineMs`. Both fields can be
`undefined` for workers in non-running states or before the first
heartbeat. Treat `undefined` explicitly — never coerce to `0`.

```
// Status-priority short-circuits — registry status drives more than heartbeat.
if (status === "exited" || status === "crashed") return "terminal";
if (status === "detached")    return "detached";
if (status === "terminating") return "terminating";

// status is "starting" or "running" → derive from per-worker health snapshot
const workerSnap = health.workers.find(w => w.workerId === row.workerId);

// Workers can opt out of heartbeat monitoring (BackendHints.heartbeat:false).
// In that case `lastHeartbeatAt` AND `heartbeatDeadlineAt` are permanently
// undefined on the snapshot — NOT a transient pre-first-heartbeat state.
// We can distinguish "opted out" from "opted in but not yet beating" by
// checking the opt-in flag exposed on the worker snapshot. The snapshot
// must carry `heartbeatOptedIn: boolean` (or equivalent) for this to work;
// if not yet present in L0, this PR adds it as a small adjacent change to
// the SupervisorHealth.workers[] schema (one boolean, well-scoped).
const optedIn = workerSnap?.heartbeatOptedIn ?? false;
if (!optedIn) return "unmonitored";

const lastHeartbeatAt    = workerSnap?.lastHeartbeatAt ?? null;
const heartbeatDeadlineAt = workerSnap?.heartbeatDeadlineAt ?? null;

if (heartbeatDeadlineAt === null || lastHeartbeatAt === null) {
  // Opted in but no heartbeat yet (transient; bounded by deadline once set).
  const PENDING_GRACE_MS = 30_000;
  if (now - startedAt < PENDING_GRACE_MS) return "pending";
  return "timeout";
}

if (now <= heartbeatDeadlineAt) return "ok";
const interval = heartbeatDeadlineAt - lastHeartbeatAt;
if (now - heartbeatDeadlineAt < interval) return "stale";
return "timeout";
```

Notes:
- Heartbeat is opt-in on the daemon side via
  `WorkerSpawnRequest.backendHints.heartbeat`. The TUI MUST surface
  unmonitored workers as such — coloring them red on telemetry absence
  is a false alarm.
- This PR adds `heartbeatOptedIn: boolean` to the `WorkerSnapshot` shape
  in `@koi/core/daemon` (L0). One field, well-scoped, derived directly
  from the existing `WorkerSpawnRequest.backendHints.heartbeat` plumbing.
  Without it, "unmonitored vs pending vs broken" is indistinguishable
  from outside the supervisor.
- Pending grace is a fixed 30s constant.
- Stale window derived from `(deadlineAt - lastHeartbeatAt)`.

Render mapping in `BgView`:

| Freshness | Color | Meaning |
|-----------|-------|---------|
| `pending` | neutral (gray) | heartbeat opt-in, no heartbeat yet, within grace |
| `ok` | green | heartbeat fresh |
| `stale` | yellow | heartbeat lagging |
| `timeout` | red | heartbeat past 2× deadline (live worker, dead-or-stuck) |
| `unmonitored` | neutral (gray, italic) | heartbeat not opted in — health not knowable from telemetry |
| `terminating` | yellow + spinner | kill in flight (`signaledAt` age in tooltip) |
| `detached` | blue | tmux/remote backend let go; needs reattach |
| `terminal` | gray | `exited`/`crashed`; row kept until retention sweep |

### Kill flow

The TUI shares a process with the supervisor (the daemon was instantiated
by CLI bootstrap). That makes this an **on-path** kill — the supervisor
is the canonical owner and `supervisor.stop(workerId, reason)` is the
correct entry point. The off-path CAS dance (`expectedVersion` +
`expectedPid` + birth-time fingerprint) lives in
`packages/meta/cli/src/commands/bg.ts` and stays untouched; it exists for
the cross-process case (`koi bg kill` invoked from a separate shell with
no live supervisor).

The TUI's only race concern is **respawn under the same `workerId`**: a
restart policy can replace the live process between row selection and
confirm. We detect this via the registry's `version` field, which the
existing `attachRegistry` bridge already advances on every transition.

**Action availability per row** (BgView gates `k` on row state — never
advertises an action it cannot deliver):

| Row status | `k` available? | Action |
|------------|:--------------:|--------|
| `running`, `starting` | ✅ | confirm → on-path supervisor.stop |
| `terminating` | ❌ | hint: "kill in flight; wait" |
| `detached` | ❌ | hint: "use `koi bg kill <id>` from a separate shell, or `koi bg attach`" — falls back to off-path CLI flow whose CAS+fingerprint protections handle the no-supervisor case correctly |
| `exited`, `crashed` | ❌ | hint: "already terminal" |

The detached-kill recovery path is intentionally NOT routed through the
TUI bridge. The off-path `runKill` in `packages/meta/cli/src/commands/bg.ts`
is the canonical recovery flow — it handles PID-reuse fingerprinting,
stranded-claim resume, and pid-aware CAS. Reimplementing those
guarantees in the TUI bridge would duplicate ~200 LOC of subtle race
handling. Pointing operators at `koi bg kill` is the correct contract.

For supported rows (`running`/`starting`):

1. `BgView`: user presses `k` on a row → dispatch
   `set_bg_kill_confirm({ workerId, version, pid })` capturing the
   identity the operator saw.
2. Modal renders. `y` → call
   `onCommand("system:bg-kill", { workerId, expectedVersion, expectedPid })`.
3. `tui-root` routes to
   `bridge.requestKill({ workerId, expectedVersion, expectedPid })`.
4. Bridge re-reads the live record:
   `current = await registry.get(workerId as WorkerId)`.
   - **`current === undefined`** — record was unregistered (e.g. retention
     sweep finalized). Toast `"⚠ worker <id> already gone"`, return.
   - **`current.status === "exited" | "crashed"`** — already terminal.
     Toast `"⚠ worker <id> is ${status}"`, return.
   - **`current.status === "terminating"`** — kill already in flight from
     another caller. Toast `"⚠ worker <id> kill already in progress"`,
     return.
   - **`current.version !== expectedVersion || current.pid !== expectedPid`**
     — the worker was respawned under the same `workerId` since the
     operator selected the row. Toast `"⚠ worker <id> respawned; refresh
     and try again"`, return. **No `supervisor.stop` call** — never kill
     a process the operator did not pick.
   - **`current.status === "detached"`** — backend (e.g. tmux) detached
     the worker; the supervisor no longer owns the OS process and
     `supervisor.stop` is a no-op. Toast `"⚠ worker <id> is detached;
     reattach with `koi bg attach` first"`, return.
5. Bridge calls `await supervisor.stop(workerId, "user-requested")`.
   `Result<void, KoiError>` — rejection is impossible (the API returns a
   `Result`); inspect `.ok`:
   - `ok: false` → toast `"⚠ supervisor.stop failed: ${err.message}"`,
     return without crashing the bridge.
   - `ok: true` → done. The supervisor publishes `stopped` to `watchAll()`,
     `attachRegistry` advances the record to `exited`, the next poll tick
     refreshes the row.
6. Cancel paths (`n` or Esc on the modal) → dispatch
   `set_bg_kill_confirm({ confirm: null })`. No supervisor calls made.

### Log tail

Selection identity is `workerId` end-to-end — `sessionId` is optional
display-only metadata and is never the row key. `Enter` on row → dispatch
`set_bg_tailing({ workerId })` → `BgLogTail` resolves the matching row
from `state.bg.rows` and reads `logPath` from there.

Tail behavior must survive **truncation, rotation, and recreation**
across worker restarts (a transient/permanent restart policy spawns a new
process which often opens a fresh log file under the same path; the tailer
must follow it without losing or duplicating output).

State the tailer tracks:

```typescript
interface TailerState {
  readonly path: string;
  readonly inode: number | null;     // bigint stat ino, narrowed to number safely
  readonly device: number | null;    // (inode, dev) tuple is the file identity
  readonly readOffset: number;       // bytes read so far from current file
  readonly buffer: readonly string[]; // ring buffer cap 1000 lines
}
```

Loop:

1. **Initial open** — `stat(logPath)`. Two outcomes:
   - **success** → record `(ino, dev, size)`; read last 1000 lines via
     reverse-chunked read; set `readOffset = size`. Proceed to step 2.
   - **ENOENT** → enter `waiting` state with banner `… waiting for log
     file …`. Poll `stat` every 250ms (no time limit — `starting`
     workers can pre-register before the backend opens stdout). On first
     successful `stat`, behave as initial open + render `--- log opened ---`
     banner. `Esc` exits the waiting state.
2. **Watch** — `fs.watch(logPath)` AND a continuous **liveness watchdog**
   (separate `setInterval` at 1s). On any `fs.watch` event OR every
   watchdog tick:
   - `stat(logPath)`. Resolve via this case table:
     | Condition | Meaning | Action |
     |-----------|---------|--------|
     | `(ino, dev)` unchanged AND `size >= readOffset` | normal append | read `[readOffset, size)`; advance offset |
     | `(ino, dev)` unchanged AND `size < readOffset` | truncation in place | reset `readOffset = 0`, render `--- log truncated ---`, read from start |
     | `(ino, dev)` changed | rotation/restart | close prior fd, reopen, render `--- log rotated ---`, reset offset to 0, read full new file, **rebind `fs.watch` to the new inode** (the prior watch handle silently went dead the moment the file was replaced) |
     | `stat` ENOENT | file deleted; await recreate | continue 250ms `stat` poll until recreate, then resolve as rotation |
3. **Watchdog never expires** — unlike the previous spec, the 1s `stat`
   sweep runs for the lifetime of the component. `fs.watch` is treated as
   an optimization (low-latency notify), not the primary signal. This
   closes the documented `fs.watch` failure modes:
   - watch handle silently drops after rename on macOS HFS+/APFS,
   - watch never fires for tail-only writes when the backend uses
     `O_APPEND` semantics that some kernels coalesce.
4. **Cleanup on Esc / unmount** — close fd; clear `fs.watch` handle; clear
   watchdog interval; clear ENOENT poll if active. Ring buffer (cap 1000
   lines) discarded with the component.

Banners render inline so operators see the discontinuity rather than a
silent gap or duplicate. The watchdog overhead (a single `stat` per
second per open tail) is negligible vs. the cost of a stalled tail in
an incident.

## Hidden status-line

When `supervisor.health()` returns `null` (no supervisor attached) or
`attached === false`, status-bar render skips the supervisor segment. Order
on the right side: governance segment, then supervisor segment, separator
`·`. No layout collision since both segments self-elide when empty.

## Testing

### Unit tests (bun:test, colocated)

- **`reduce.test.ts`** — new actions update slices; events ring buffer caps
  at 50; bg row freshness boundaries cover all 8 outcomes (pending, ok,
  stale, timeout, **unmonitored**, terminating, detached, terminal):
  - heartbeat-opt-out worker → `unmonitored` (never `timeout`).
  - heartbeat-opt-in pre-first-beat → `pending` for 30s grace, then
    `timeout`.
  - status-priority short-circuits for `exited`/`crashed`/`detached`/`terminating`.
  - per-worker lookup by `workerId`.
  - stale-interval derivation from `(deadlineAt - lastHeartbeatAt)`.
- **`StatusBar.test.tsx`** — badge renders ◎/◑/● per `health.status` when
  bridge `live`; renders `◌ stale Ns` when bridge `stale`; segment hidden
  when `detached`; format `"3/5 workers"`.
- **`SupervisorView.test.tsx`** — worker table columns; reasons section
  hidden when empty; event feed last-N order.
- **`BgView.test.tsx`** — registry rows merged with health workers; kill
  modal flow only opens for `running`/`starting` rows; `terminating`,
  `detached`, `exited`, `crashed` rows render `k` disabled with
  status-specific hint; Enter dispatches `set_bg_tailing({ workerId })`
  using the row's workerId (never sessionId).
- **`BgLogTail.test.tsx`** — initial reverse-tail produces last 1000 lines;
  appended write extends buffer; truncation resets offset + renders
  `--- log truncated ---`; inode change renders `--- log rotated ---`,
  reads new file from start, **rebinds `fs.watch` to the new inode**;
  `stat` ENOENT at startup enters `waiting` state (no time limit), then
  resumes on first successful stat with `--- log opened ---` banner;
  watchdog 1s `stat` sweep detects writes when fs.watch silently drops
  (verified via spy on `fs.watch.close()` mid-stream); unmount closes
  fd + clears watcher + clears watchdog interval + clears ENOENT poll.
- **`daemon-bridge.test.ts`** —
  - `WorkerEvent.crashed` triggers `push_toast` + `push_supervisor_event`;
    same crash within 30s deduped to 1 toast.
  - `WorkerSnapshot.state` `running→quarantined` (health diff) fires toast
    once per transition; subsequent polls in `quarantined` do not retoast.
  - `running→restarting` (health diff) fires info toast (not warning).
  - Worker disappearing between health snapshots does not synthesize a
    fake terminal event — only the next push event is authoritative.
  - `health` ok→degraded transition fires toast (not on every tick).
  - `requestKill` happy path: refreshes registry, calls
    `supervisor.stop(workerId, "user-requested")`, no toast.
  - `requestKill` refuses when current record is `undefined`, `exited`,
    `crashed`, `terminating`, or `detached` — surfaces correct toast,
    `supervisor.stop` not called.
  - `requestKill` refuses on respawn race (`version` or `pid` advanced
    past `expected*`) — toast `"respawned; refresh and try again"`,
    `supervisor.stop` not called.
  - `supervisor.stop` returning `Result.ok: false` surfaces as toast
    without crashing the bridge.
  - 3 consecutive `health()` failures flip status to `stale` while
    preserving last snapshot.
  - `watchAll()` failure flips status to `degraded` with
    `missing: ["workerEvents"]` while polls keep working; rows + badge
    still update from `health()` + `list()`.
  - Recovery composite rule: `degraded → live` requires the failed push
    channel to actually reattach; a successful poll alone does NOT clear
    `degraded`.
  - Restored toast fires only on `degraded → live` or `stale → live`
    transition, not on intermediate steps.
  - `watchAll()` iterator throwing triggers indefinite reacquire with
    backoff `1s → 60s` (verified via fake timers): 6th failure schedules
    next attempt, never gives up; `bridge.close()` during a backoff sleep
    cancels the wait via the closed sentinel.
  - During a stream outage, `health()` + `list()` polling continues —
    rows + badge stay current in poll-only mode.
  - `registry.watch()` iterator throwing triggers an independent backoff
    reacquire — does NOT cancel `watchAll`.
  - `close()` resolves the `closed` sentinel, both consumer loops drain,
    polls clear, no leaked timers.
  - Bridge uses `registry.describeList()` not `list()`: a permission-denied
    fixture returns `Result.ok: false`, surfaces as stale; the lenient
    `list()` empty-fallback is never invoked.
  - Shutdown ordering: `supervisor.shutdown()` resolves before
    `bridge.close()`; final `stopped` events from shutdown reach the
    store. Reversed-order regression test (close-before-shutdown) loses
    events — guarded by an explicit assertion that ordering matches spec.
- **`wire-daemon-supervisor.test.ts`** — manifest with subprocess child
  instantiates daemon + registry + bridge; manifest with only in-process
  children skips daemon; dispose tears down in reverse order.

### E2E (tmux harness, gated on `$RUN_E2E`)

`packages/ui/tui/src/__tests__/daemon-tui-e2e.test.ts`:

- manifest with subprocess supervision → `◎ ok` badge appears.
- `os.kill` worker → `⚠` toast + status flips to `◑`.
- Stall worker past heartbeat deadline → timeout toast + `/bg` row red.
- `/supervisor` renders worker tree with uptime + restart counts.
- `/bg` table merges registry + health; `k` confirm terminates worker;
  row flips to `exited`.
- Manifest without `supervision:` → no badge.

### Coverage target

≥80% per `bunfig.toml`. Bridge + reducer get the tightest assertions; views
snapshot-tested.

### Golden trajectory

Skipped — TUI surface is observability over runtime, no new model/tool
calls. Existing daemon golden queries cover supervisor lifecycle.

## Risks

| Risk | Mitigation |
|------|------------|
| Polling at 1s × 2 in idle TUI | Bridge stops polls when `attached:false` and on `close()`. Polls coexist with `watchAll`/`registry.watch` event streams as defense in depth, not duplicate work. |
| `watchAll()` parked-iterator cancellation | Use the closed-sentinel race pattern proven in `attachRegistry` — never `await iter.return()`. |
| `BackgroundSessionStatus` adds future variants | The slice mirrors the L0 union directly; if L0 widens, TS exhaustiveness in the freshness reducer catches it before runtime. |
| Adjacent L0 addition: `WorkerSnapshot.heartbeatOptedIn` | New boolean on the published health snapshot. Mechanically derived from existing `WorkerSpawnRequest.backendHints.heartbeat` plumbing — no semantic change. Self-contained: one field, one schema bump, no migration. Without it, the TUI cannot distinguish "opted out" from "hung," which is the exact false-alarm risk this PR exists to avoid. |
| Inferred state (quarantined/restarting toasts derived from health diffs) | Documented as derived in the feed entry; no synthetic event timestamps. If the L0 `WorkerEvent` union later grows discrete `quarantined`/`restarting` events, swap the derivation for the push event in one place. |
| `fs.watch` macOS rename quirks | Fallback to `stat+read` polling at 500ms after 5s of no events. Cap tail buffer at 1000 lines. |
| Spawn tool output needs `workerId` | Verify Spawn tool result schema during impl; thread `workerId`/`backendKind` through if missing. Small adjacent change if needed. |
| Status-bar collision with `/governance` badge | Both render right-side; explicit ordering: governance first, supervisor second, separator `·`. Each segment self-elides. |
| Test flakiness on tmux E2E | Gate on `$RUN_E2E`; CI keeps unit tests as source of truth for #1944 acceptance. |
| Toast spam on rapid restart loops | 30s TTL dedup per `(sessionId, workerId, kind)`. Quarantine event always shown (terminal state). |

## Out of Scope

- Mutation UI in `/supervisor` (interactive restart/resume) — issue defers.
- Cross-session aggregation (supervised trees across user sessions) — Phase 4.
- Historical log retention beyond `FileSessionRegistry`'s 24h sweep.
- Remote/tmux backends — future Phase 3b-6+.
- Replacing the existing in-process stub in `wire-manifest-supervision.ts`
  for in-process-only manifests — out of scope; that path keeps the
  `/agents` Supervised section as today.

## Dependencies

- **#1338** (supervisor + worker management) — shipped.
- **#1340** (session registry + `koi bg` CLI) — shipped.
- **#1341** (heartbeat + health) — shipped.
- **#1866** (manifest.supervision wired into runtime + TUI for in-process
  stub path) — shipped, but real daemon supervisor never instantiated.
  This PR completes the gap.
- **#1876** (governance TUI surface) — UX precedent for status-line and
  full-screen views; align terminology.

## Acceptance

- [ ] All anti-leak rules from CLAUDE.md hold (no L2-on-L2; no L1 imports
      from TUI; types-only L0 imports).
- [ ] `bun run typecheck`, `bun run lint`, `bun run check:layers`,
      `bun run check:unused`, `bun run check:duplicates` pass.
- [ ] Unit + integration tests pass with ≥80% coverage on touched files.
- [ ] tmux E2E suite runs green when `$RUN_E2E` set.
- [ ] Manifest with `supervision:` + subprocess child shows `◎` badge in
      TUI status line within 1s of startup.
- [ ] Killing a supervised worker via `os.kill` produces a toast within
      heartbeat deadline + 1s.
- [ ] `/bg` `k` flow terminates a `running` worker and updates the row to
      `exited`.
- [ ] `/bg` `k` is disabled for `detached`/`terminating`/`exited`/`crashed`
      rows; detached row hint references `koi bg kill` recovery path.
- [ ] Manifest without `supervision:` and in-process-only `supervision:`
      both render no badge; in-process supervision keeps showing in
      `/agents` Supervised section as before.
- [ ] Killing the supervisor `watchAll()` mid-session (induced fault)
      flips badge to `◐ degraded` (push channel down, polls live);
      successful reacquire restores `◎ live` automatically, with the
      restoration toast firing exactly once on `degraded → live`.
- [ ] Restarting a supervised worker rotates its log file; `BgLogTail`
      renders `--- log rotated ---` and continues following the new file
      without losing or duplicating lines (E2E case).
