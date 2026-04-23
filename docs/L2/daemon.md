# @koi/daemon — OS-Process Worker Supervisor

Supervise OS-level worker processes for long-running agent work. Provides a pluggable `WorkerBackend` contract (swappable execution substrates), a pool-managing `Supervisor` with restart/maxWorkers/graceful-shutdown, and an in-tree Bun subprocess backend.

## Recent updates

- `createSupervisor` keeps the heartbeat-aware backend selection path and returns explicit `UNAVAILABLE` diagnostics when availability probes fail or time out, so operators can distinguish transient backend outages from static misconfiguration.
- `createSubprocessBackend` and supervisor wiring stay aligned on heartbeat opt-in behavior (`backendHints.heartbeat`) with a single `@koi/core` contract surface for daemon types.

---

## Why It Exists

1. **Process substrate below logical supervision.** Koi already has Erlang/OTP-style *logical* supervision in L0 (`SupervisionConfig`, `SupervisionReconciler` in `@koi/engine-reconcile`) that decides WHEN to restart an agent. `@koi/daemon` is the layer below — it decides HOW to spawn/terminate the underlying OS process. The two layers are independent: the reconciler consumes a `SpawnFn`, and at the integration boundary that `SpawnFn` delegates into a daemon `Supervisor`.

2. **Swappable backends.** Workers may run in-process (for tests), as local subprocesses (default production), inside tmux panes (for interactive swarms), or on remote hosts (via Nexus). The `WorkerBackend` contract abstracts all four — the supervisor code is substrate-agnostic.

3. **Safe graceful shutdown.** A SIGTERM/SIGINT at the process level must flow through to every supervised worker, give them a deadline to exit cleanly, then force-kill. `@koi/daemon` implements this orchestration so agent code never has to.

4. **Unified observability.** Every worker event (started, heartbeat, exited, crashed) fans into a single `AsyncIterable` via `supervisor.watchAll()`. Middleware, UI, and telemetry subscribe to one stream regardless of how many workers or backends are live.

---

## What This Enables

### Long-Running Agent Workers

An agent can delegate to a worker that outlives the parent request:

```
Parent agent: "Research the codebase for 10 minutes, then report"
  → supervisor.start({ workerId, agentId, command: [...] })
  → Subprocess backend spawns Bun child with agent bootstrap
  → Parent returns control to the user immediately
  → Worker runs independently, emits events via watchAll()
  → Worker exits with result → supervisor removes from pool
```

### Crash-Resilient Workers

A worker that crashes is respawned with exponential backoff, up to a budget:

```
Worker exits with SIGSEGV (code=139)
  → supervisor observes "crashed" event
  → Policy: transient, maxRestarts=3, maxRestartWindowMs=60_000
  → Attempt 1: wait 1s, respawn
  → Still crashing after 3 attempts in 60s → supervisor stops restarting
  → "crashed" event surfaces through watchAll() for observability
```

### SIGTERM-Aware Shutdown

A supervisor registered with `registerSignalHandlers` triggers graceful shutdown on user interrupt:

```
User hits Ctrl-C on the TUI
  → Process receives SIGINT
  → registerSignalHandlers invokes supervisor.shutdown("SIGINT")
  → Every worker's backend.terminate(id) fires (SIGTERM to subprocess children)
  → Each worker has shutdownDeadlineMs to exit cleanly
  → Workers that miss the deadline get backend.kill(id) (SIGKILL)
  → Pool empties, supervisor resolves
```

---

## Architecture

### Layer

`@koi/daemon` is an **L2 feature package**. Imports only `@koi/core` (L0) and `@koi/errors` (L0u). No L1 or peer-L2 dependencies.

### Module Map

```
src/
├── create-supervisor.ts            createSupervisor() factory — pool, lifecycle, restart, event fan-in
├── subprocess-backend.ts           createSubprocessBackend() — Bun.spawn-based WorkerBackend
├── file-session-registry.ts        createFileSessionRegistry() — cross-process session registry
├── registry-supervisor-bridge.ts   attachRegistry() — supervisor events → registry writes
├── signal-handlers.ts              registerSignalHandlers() — SIGTERM/SIGINT bridge to shutdown
├── backoff.ts                      computeBackoff() — exponential backoff helper
├── heartbeat-monitor.ts            createHeartbeatMonitor() — per-worker deadline timers with synthetic-crash-on-timeout
├── heartbeat-opt-in.ts             isHeartbeatOptIn() — shared predicate for backendHints.heartbeat opt-in
├── supervisor-health.ts            buildHealth() + deriveStatus() — health snapshot composition helpers
└── index.ts                        public re-exports
```

### L0 Contracts Consumed

All of the following live in `@koi/core` and are consumed by this package:

| Type | Purpose |
|------|---------|
| `WorkerBackend` | Swappable execution substrate (kind/spawn/terminate/kill/isAlive/watch). `watch(id, signal?)` accepts an optional `AbortSignal`; the supervisor aborts it on `stop()`/`shutdown()` so backends that can't guarantee terminal event emission still release their watch-stream resources. |
| `WorkerBackendKind` | `"in-process" \| "subprocess" \| "tmux" \| "remote"` |
| `WorkerSpawnRequest` | Spawn payload (workerId, agentId, command, cwd?, env?, backendHints?) |
| `WorkerHandle` | Per-worker runtime handle (signal, startedAt, backendKind) |
| `WorkerEvent` | Discriminated union: started / heartbeat / exited / crashed |
| `Supervisor` | Pool operations: start / stop / shutdown / list / watchAll |
| `SupervisorConfig` | maxWorkers, shutdownDeadlineMs, backends registry, restart? |
| `WorkerRestartPolicy` | restart (`RestartType` reused from `@koi/core/supervision`), maxRestarts, window, backoff |
| `DEFAULT_WORKER_RESTART_POLICY` | `{ transient, 5, 60_000, 1000, 30_000 }` |
| `validateSupervisorConfig` | Pure validator → `Result<SupervisorConfig, KoiError>` |
| `BackgroundSessionRecord` | Persisted per-session metadata (pid, status, startedAt, logPath, command, …) |
| `BackgroundSessionStatus` | `"starting" \| "running" \| "exited" \| "crashed" \| "detached"` |
| `BackgroundSessionRegistry` | register / update / unregister / get / list / watch |
| `BackgroundSessionEvent` | Discriminated union: registered / updated / unregistered |
| `BackgroundSessionUpdate` | Partial update patch for mutable lifecycle fields |
| `validateBackgroundSessionRecord` | Pure validator → `Result<BackgroundSessionRecord, KoiError>` |

---

## Public API

### createSupervisor

```typescript
import {
  createSupervisor,
  createSubprocessBackend,
  registerSignalHandlers,
} from "@koi/daemon";
import { agentId, workerId } from "@koi/core";

const supervisorResult = createSupervisor({
  maxWorkers: 8,
  shutdownDeadlineMs: 10_000,
  backends: {
    subprocess: createSubprocessBackend(),
  },
  restart: {
    restart: "transient",
    maxRestarts: 5,
    maxRestartWindowMs: 60_000,
    backoffBaseMs: 1_000,
    backoffCeilingMs: 30_000,
  },
});

if (!supervisorResult.ok) throw new Error(supervisorResult.error.message);
const supervisor = supervisorResult.value;

// Hook SIGTERM/SIGINT → graceful shutdown
const unregister = registerSignalHandlers(supervisor);

// Spawn a worker
const started = await supervisor.start({
  workerId: workerId("w-researcher-1"),
  agentId: agentId("researcher"),
  command: ["bun", "run", "./worker-entry.ts", "--role", "researcher"],
  cwd: "/workspace/koi",
  env: { LOG_LEVEL: "debug" },
});

// Subscribe to aggregate events
for await (const ev of supervisor.watchAll()) {
  console.log(ev.kind, ev.workerId, ev.at);
  if (ev.kind === "exited" || ev.kind === "crashed") break;
}

// Graceful teardown
await supervisor.shutdown("app-exit");
unregister();
```

### createSubprocessBackend

Zero-config Bun subprocess backend:

```typescript
const backend = createSubprocessBackend();
// backend.kind === "subprocess"
// backend.isAvailable() === true  (requires Bun runtime)
```

Uses `Bun.spawn(command, { cwd, env, stdin: "inherit", stdout: "pipe", stderr: "pipe" })`. Emits:
- `started` synchronously on spawn
- `exited` when `proc.exited` resolves with code=0
- `crashed` (with `INTERNAL` KoiError, retryable=true) when code≠0
- `crashed` (with `INTERNAL`, retryable=false) if the backend watch stream itself fails

### createFileSessionRegistry

File-backed cross-process session registry. One JSON file per worker under the
configured directory; atomic writes via tmp+rename so concurrent readers never
observe a half-written record. Consumers (CLI `koi bg ps`, admin dashboards,
external tooling) read the registry directly from disk without contacting the
supervisor.

```typescript
import { createFileSessionRegistry } from "@koi/daemon";

const registry = createFileSessionRegistry({
  dir: `${process.env.KOI_STATE_DIR}/daemon/sessions`,
});

await registry.register({
  workerId: workerId("w-researcher-1"),
  agentId: agentId("researcher"),
  pid: 12345,
  status: "starting",
  startedAt: Date.now(),
  logPath: "/var/log/koi/w-researcher-1.log",
  command: ["bun", "worker.ts"],
  backendKind: "subprocess",
});

await registry.update(workerId("w-researcher-1"), { status: "running" });
const active = await registry.list();
for await (const ev of registry.watch()) console.log(ev.kind, ev);
```

### attachRegistry

Bridges supervisor lifecycle events into registry writes. Callers register a
session BEFORE calling `supervisor.start()`; the bridge flips `status` from
`starting` → `running` → `exited`/`crashed` and records `endedAt`/`exitCode`
as the events fire.

```typescript
import { attachRegistry } from "@koi/daemon";

const bridge = attachRegistry({
  supervisor,
  registry,
  onError: (err, event) => log.warn("registry bridge", err, event),
});

// Later, during teardown:
await bridge.close();
```

### registerSignalHandlers

```typescript
const unregister = registerSignalHandlers(supervisor);
// Attaches SIGTERM + SIGINT handlers. Each invokes supervisor.shutdown(sig).
// Returns cleanup function — call on app teardown or test cleanup.
```

Does NOT call `process.exit`. Callers decide exit behavior after shutdown completes.

---

## Behavior

### Pool Capacity

`SupervisorConfig.maxWorkers` is a hard cap. `start()` beyond capacity returns a typed `KoiError` with `code: "RESOURCE_EXHAUSTED"` (retryable=true). The slot frees when:
- `stop(id)` is called
- `shutdown(reason)` is called
- A worker exits or crashes (even before restart logic attempts respawn — so restart itself won't exceed cap)

### Restart Policy

Restart decisions follow `WorkerRestartPolicy.restart` (`permanent | transient | temporary` — same semantics as `@koi/core/supervision`):

| Event | permanent | transient | temporary |
|-------|-----------|-----------|-----------|
| `exited` (code=0) | restart | no restart | no restart |
| `crashed` (code≠0 or backend error) | restart | restart | no restart |

Restart budget enforced by `maxRestarts` within `maxRestartWindowMs` (sliding window). Backoff between attempts: `Math.min(backoffBaseMs * 2^attempt, backoffCeilingMs)`.

### Graceful Stop

`supervisor.stop(id, reason)` races `backend.terminate(id, reason)` against `shutdownDeadlineMs`:
- If terminate wins: entry removed from pool, `{ ok: true }`
- If deadline wins: `backend.kill(id)` fires (SIGKILL equivalent), entry removed, `{ ok: true }`

Workers not in the pool return `{ ok: false, error.code: "NOT_FOUND" }`.

### Watch Cancellation

Each pool worker owns an `AbortController`; its signal is passed into
`backend.watch(id, signal)`. After the deadline-bounded terminate/kill
completes, `stop()` aborts the signal so any backend still holding a watch
stream releases it. Backends that emit the terminal event naturally ignore
the abort (the for-await already exited); backends that stall or drop the
stream without emitting a terminal event honor the abort and exit their
generator, so the supervisor's watch IIFE never leaks past stop()/shutdown().

### Backend Selection

When `SupervisorConfig.backends` registers multiple kinds, `start()` picks in this order: subprocess → in-process → tmux → remote. Override via `start(req, { backend: "in-process" })`.

---

## Heartbeat Protocol

Workers can opt into supervisor-side liveness monitoring by sending heartbeat messages over Bun's native IPC channel. Unlike OS-level `isAlive` polling (which only catches crashes), heartbeats also detect hangs — a looping worker that never finishes a task will miss its heartbeat deadline and be torn down.

### Opting in

Set `backendHints.heartbeat: true` in the spawn request:

```typescript
await supervisor.start({
  workerId: workerId("research-1"),
  agentId: agentId("agent-research"),
  command: ["bun", "run", "./my-worker.ts"],
  backendHints: { heartbeat: true },
});
```

### Child-side pattern

The child process sends a single-shape message over IPC:

```typescript
// Inside the worker's main loop:
setInterval(() => {
  if (typeof process.send === "function") {
    process.send({ koi: "heartbeat" });
  }
}, 5_000); // Advisory cadence — must be shorter than config.heartbeat.timeoutMs
```

The supervisor ignores any IPC message that is not a heartbeat, leaving room for future control messages.

### Configuration

`SupervisorConfig.heartbeat` sets global defaults (`DEFAULT_HEARTBEAT_CONFIG = { intervalMs: 5_000, timeoutMs: 15_000 }`):

```typescript
const supervisor = createSupervisor({
  maxWorkers: 4,
  shutdownDeadlineMs: 10_000,
  heartbeat: { intervalMs: 5_000, timeoutMs: 15_000 },
  backends: { subprocess: createSubprocessBackend() },
});
```

### Timeout behavior

If no heartbeat arrives within `timeoutMs`, the supervisor:

1. Publishes a synthetic `WorkerEvent` of kind `"crashed"` with `error.code = "HEARTBEAT_TIMEOUT"` — visible via `watchAll()` to any observer.
2. Invokes `stop(workerId, "heartbeat-timeout")` — graceful terminate, then kill after `shutdownDeadlineMs`.
3. Does not auto-restart. Callers that want automatic restart after a heartbeat timeout should wrap `stop()`; this may become a first-class policy in a follow-up issue.

The first heartbeat must arrive within `timeoutMs` of spawn — there is no separate startup grace window. Workers with non-trivial boot cost should emit an early heartbeat as soon as initialization completes.

## Health Reporting

`supervisor.health()` is a synchronous, in-memory snapshot of both per-worker health and supervisor self-health:

```typescript
const h: SupervisorHealth = supervisor.health();
// h.status:  "ok" | "degraded" | "unhealthy"
// h.reasons: readonly string[]   (machine-readable tags)
// h.metrics: SupervisorHealthMetrics  (raw counters)
// h.workers: readonly WorkerHealth[]  (per-worker detail)
```

### Status derivation

- `"unhealthy"` ⇢ supervisor is shutting down
- `"degraded"` ⇢ any of: quarantined workers exist, event-buffer drops occurred, pool is at capacity
- `"ok"` ⇢ no degrading condition

Reasons vocabulary:
- `"shutting_down"` — supervisor-level
- `"quarantined_workers"` — one or more workers have unconfirmed liveness
- `"event_buffer_drops"` — the event ring buffer has evicted events (subscribers may have missed some)
- `"at_capacity"` — `poolSize + pendingSpawnCount >= maxWorkers`

### WorkerHealth fields

```typescript
interface WorkerHealth {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  readonly state: "running" | "restarting" | "quarantined" | "stopping";
  readonly lastHeartbeatAt: number | undefined;       // undefined for non-heartbeat-tracked workers
  readonly heartbeatDeadlineAt: number | undefined;   // undefined for non-heartbeat-tracked workers
}
```

Non-heartbeat-tracked workers (those spawned without `backendHints.heartbeat: true`) appear in `workers[]` with `lastHeartbeatAt` and `heartbeatDeadlineAt` set to `undefined`.

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxWorkers` | (required) | Hard cap on concurrent workers |
| `shutdownDeadlineMs` | (required) | Max ms to wait for graceful terminate before SIGKILL |
| `backends` | (required) | `Record<WorkerBackendKind, WorkerBackend>` — at least one |
| `restart` | `DEFAULT_WORKER_RESTART_POLICY` | Per-worker restart policy (overridable per-spawn) |

---

## Testing

- **21 tests** across 5 test files
- Key test files:
  - `supervisor.test.ts` — start, maxWorkers, stop, shutdown, watchAll (including concurrent subscribers, rapid-publish burst)
  - `restart-policy.test.ts` — transient restart, temporary no-restart, budget exhaustion
  - `subprocess-backend.test.ts` — spawn + exit, SIGTERM terminate, crashed on non-zero exit
  - `backoff.test.ts` — doubling, ceiling cap, zero base
  - `signal-handlers.test.ts` — SIGTERM/SIGINT → shutdown, cleanup fn removes listeners
- `fake-backend.ts` test helper — in-memory `WorkerBackend` with synchronous crash/exit controls

---

## CLI Integration — `koi bg`

The CLI bundles a thin operator surface over the registry. Commands run in a
separate process from the supervisor and talk to the registry directly on
disk:

| Command | Purpose |
|---------|---------|
| `koi bg ps` | List registered sessions (table by default, `--json` for structured output) |
| `koi bg logs <id>` | Tail a session's log file; `--follow` keeps streaming while the session is live |
| `koi bg kill <id>` | SIGTERM the session's PID; escalate to SIGKILL after 5 s if still alive; update the registry |
| `koi bg attach <id>` | Interactive attach — subprocess backend falls back to read-only log tail; full bi-directional attach ships with the tmux backend (3b-6) |
| `koi bg detach` | Operator notice — subprocess backend has no detachable session; tmux backend handles the flow |

Default registry directory: `$KOI_STATE_DIR/daemon/sessions`; falls back to
`~/.koi/daemon/sessions`. Override with `--registry-dir`.

## Limitations / Follow-Ups

- Event buffer is bounded at 1000 events with FIFO eviction; `supervisor.health().metrics.eventDropCount` surfaces eviction count.
- **Only subprocess backend ships in this package.** `in-process`, `tmux`, and `remote` backends are reserved kinds but not implemented — future peer L2 packages (e.g. `@koi/daemon-backend-tmux`).
- **Subprocess integration with `SupervisionReconciler` is deferred to #1866 (3b-5c).** 3b-5a activates the reconciler for in-process children (see `docs/L2/supervision-activation.md`); 3b-5c wires a daemon-backed `SpawnChildFn` adapter.
- **No subscriber-abandonment cleanup.** If a `watchAll` consumer abandons its iterator, the closed-over waker leaks until the next publish.

---

## References

- `@koi/core` — L0 contracts: `WorkerBackend`, `Supervisor`, `SupervisorConfig`, `WorkerEvent`, `RestartType` (from `supervision.ts`)
- `@koi/engine-reconcile` — peer L1 package implementing logical supervision; future integration target
- `@koi/errors` — shared error factory / classification utilities
- Issue [#1338](https://github.com/windoliver/koi/issues/1338) — v2 Phase 3b-1 supervisor + worker management
