# Daemon — Heartbeat + Health Monitoring (Issue #1341)

**Status:** Draft — awaiting user approval
**Target package:** `@koi/daemon` (L2) + minor `@koi/core` (L0) contract additions
**LOC budget:** ~300
**Issue:** <https://github.com/windoliver/koi/issues/1341>
**Dependency (merged):** #1338 — `@koi/daemon` supervisor + subprocess backend

## 1. Goal

Extend the `@koi/daemon` supervisor with worker heartbeat protocol, missed-heartbeat failure detection, in-memory health reporting, and supervisor self-health signaling. Worker-initiated IPC heartbeats let the supervisor detect *hangs* in addition to the crash detection that already exists.

## 2. Acceptance criteria (from issue)

- Worker heartbeat protocol ✅
- Health check endpoints (in-memory query API) ✅
- Worker failure detection (missed heartbeats) ✅
- Dead worker cleanup ✅
- Health status reporting ✅
- Supervisor self-health monitoring ✅

Tests required:
- Heartbeat received within interval
- Missed heartbeats trigger failure detection
- Dead worker cleaned up from registry
- Health endpoint returns correct status
- Supervisor monitors own health

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Health "endpoint" is an in-memory `supervisor.health()` method, not an HTTP surface | Keeps daemon focused on process supervision; HTTP belongs in a sidecar package if ever needed; matches existing in-memory patterns (`list()`, `watchAll()`) |
| D2 | Heartbeat transport for subprocess backend = Bun IPC (`Bun.spawn({ ipc: ... })`, child calls `process.send({ koi: "heartbeat" })`) | Native to Bun, typed, separates protocol from stdout, zero new deps |
| D3 | Missed heartbeat → synthetic `WorkerEvent.crashed` with `error.code = "HEARTBEAT_TIMEOUT"` → existing teardown pipeline; no new `WorkerEvent` kind | Reuses proven restart/teardown machinery, keeps L0 contract stable, respects anti-leak rules |
| D4 | Heartbeat opt-in per spawn via existing `WorkerSpawnRequest.backendHints.heartbeat = true`; cadence/timeout sourced from `SupervisorConfig.heartbeat` (with `DEFAULT_HEARTBEAT_CONFIG`) | Zero L0 schema churn on `backendHints` (already `JsonObject`), explicit caller contract, preserves compat with existing one-shot workers (`bun --version`, `sleep N`) |
| D5 | Supervisor self-health is a three-state ladder (`ok` / `degraded` / `unhealthy`) plus raw metrics | Gives both a verdict and the underlying counters in one shape; maps cleanly onto k8s readiness/liveness semantics later |
| D6 | Timeout arms at spawn time; first heartbeat must arrive within `timeoutMs` (no separate `startupGraceMs`) | Workers control boot-up grace by emitting an early heartbeat post-init; fewer knobs, symmetric with run-time cadence |
| D7 | Timeout behavior = `supervisor.stop()`. Auto-restart-after-timeout is deferred to a follow-up issue | Scope fit; preserves the AC ("dead worker cleaned up from registry") without expanding restart policy surface |
| D8 | New file `health-monitor.ts` (~180 LOC), not inlined into `create-supervisor.ts` | Existing supervisor file is 937 lines (near 800 hard max); isolation enables focused unit tests with fake timers/clocks |
| D9 | No child-side helper module; documentation shows users writing `process.send?.({ koi: "heartbeat" })` directly | One-line pattern; premature abstraction otherwise |

## 4. L0 contract additions (`packages/kernel/core/src/daemon.ts`)

```typescript
export interface HeartbeatConfig {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  intervalMs: 5_000,
  timeoutMs: 15_000,
};

export const SUPERVISOR_HEALTH_STATUS = {
  OK: "ok",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
} as const satisfies Record<string, string>;
export type SupervisorHealthStatus =
  (typeof SUPERVISOR_HEALTH_STATUS)[keyof typeof SUPERVISOR_HEALTH_STATUS];

export interface WorkerHealth {
  readonly workerId: WorkerId;
  readonly agentId: AgentId;
  readonly state: "running" | "restarting" | "quarantined" | "stopping";
  readonly lastHeartbeatAt: number | undefined;
  readonly heartbeatDeadlineAt: number | undefined;
}

export interface SupervisorHealthMetrics {
  readonly poolSize: number;
  readonly maxWorkers: number;
  readonly quarantinedCount: number;
  readonly restartingCount: number;
  readonly pendingSpawnCount: number;
  readonly eventDropCount: number;
  readonly shuttingDown: boolean;
}

export interface SupervisorHealth {
  readonly status: SupervisorHealthStatus;
  readonly reasons: readonly string[];
  readonly metrics: SupervisorHealthMetrics;
  readonly workers: readonly WorkerHealth[];
}
```

Extensions to existing L0 types:

```typescript
export interface SupervisorConfig {
  // existing fields…
  readonly heartbeat?: HeartbeatConfig | undefined;
}

export interface Supervisor {
  // existing methods…
  readonly health: () => SupervisorHealth;
}
```

Error-code convention (no new enum — `KoiError.code` is already `string`): missed-heartbeat → `error.code = "HEARTBEAT_TIMEOUT"`.

## 5. Components

### 5.1 `packages/net/daemon/src/health-monitor.ts` (NEW, ~180 LOC)

```typescript
export interface HealthMonitorDeps {
  readonly publishEvent: (ev: WorkerEvent) => void;
  readonly teardown: (id: WorkerId, reason: string) => Promise<void>;
  readonly now: () => number;
}

export interface HealthMonitor {
  readonly track: (id: WorkerId, agentId: AgentId, config: HeartbeatConfig) => void;
  readonly observe: (id: WorkerId) => void;
  readonly untrack: (id: WorkerId) => void;
  readonly shutdown: () => void;
  readonly snapshot: () => readonly WorkerHealth[];
}

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor;
```

Internal state (closure, no class):
- `Map<WorkerId, { agentId; config; lastHeartbeatAt; deadlineAt; timer: ReturnType<typeof setTimeout> }>`

`onDeadline(id)` implementation:
1. Return early if state for `id` no longer tracked (race with `untrack`).
2. `publishEvent({ kind: "crashed", workerId: id, at: now(), error: { code: "HEARTBEAT_TIMEOUT", message, retryable: true } })`.
3. `void deps.teardown(id, "heartbeat-timeout").catch((e) => swallowError(e, { package: "daemon", operation: "heartbeat-teardown" }))`.
4. Leave state entry intact — supervisor's normal exit-watch path will invoke `untrack` when teardown completes.

### 5.2 `packages/net/daemon/src/create-supervisor.ts` (+~40 LOC)

Four touch-points inside the existing factory closure:

1. **Instantiate** at top: `const healthMonitor = createHealthMonitor({ publishEvent, teardown: (id, reason) => stop(id, reason).then(() => undefined), now: Date.now });`
2. **On pool admission** in `performSpawn`: if `request.backendHints?.heartbeat === true`, `healthMonitor.track(request.workerId, request.agentId, config.heartbeat ?? DEFAULT_HEARTBEAT_CONFIG)`.
3. **Watch loop** on `ev.kind === "heartbeat"`: `healthMonitor.observe(ev.workerId)`.
4. **On terminal event / `stop` / `shutdown`**: `healthMonitor.untrack(id)`; `shutdown()` also calls `healthMonitor.shutdown()` after clearing `shuttingDown`-driven paths.

Prerequisite change (in-scope): extend the existing private structs so every worker-state map carries `agentId`. This guarantees `WorkerHealth.agentId` is always well-typed without `as` assertions (which are banned by `CLAUDE.md`).

```typescript
interface QuarantinedEntry {
  readonly backend: WorkerBackend;
  readonly agentId: AgentId;   // NEW — plumbed from the original spawn request
  readonly reason: string;
}

interface RestartingEntry {
  readonly agentId: AgentId;   // NEW — plumbed from the original spawn request
  cancelled: boolean;
  readonly done: Promise<void>;
  wake: (() => void) | undefined;
}
```

Callers that populate these maps (`performSpawn`'s quarantine branch, `scheduleRestart`) already have `request.agentId` in scope, so the plumbing is mechanical.

New `health()` method:

```typescript
const health: Supervisor["health"] = () => {
  const metrics: SupervisorHealthMetrics = {
    poolSize: pool.size,
    maxWorkers: config.maxWorkers,
    quarantinedCount: quarantined.size,
    restartingCount: restarting.size,
    pendingSpawnCount: pendingSpawns,
    eventDropCount: droppedCount,
    shuttingDown,
  };
  const tracked = healthMonitor.snapshot();
  const trackedIds = new Set(tracked.map((w) => w.workerId));
  const extras: WorkerHealth[] = [];
  for (const [id, entry] of pool) {
    if (trackedIds.has(id)) continue;
    extras.push({
      workerId: id,
      agentId: entry.handle.agentId,
      state: entry.stopping ? "stopping" : "running",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    });
  }
  for (const [id, q] of quarantined) {
    if (trackedIds.has(id) || pool.has(id)) continue;
    extras.push({
      workerId: id,
      agentId: q.agentId,
      state: "quarantined",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    });
  }
  for (const [id, r] of restarting) {
    if (trackedIds.has(id) || pool.has(id)) continue;
    extras.push({
      workerId: id,
      agentId: r.agentId,
      state: "restarting",
      lastHeartbeatAt: undefined,
      heartbeatDeadlineAt: undefined,
    });
  }
  const { status, reasons } = deriveStatus(metrics);
  return { status, reasons, metrics, workers: [...tracked, ...extras] };
};
```

### 5.3 `packages/net/daemon/src/subprocess-backend.ts` (+~30 LOC)

When `request.backendHints?.heartbeat === true`, pass an `ipc` handler to `Bun.spawn`:

```typescript
const proc = Bun.spawn([...request.command], {
  cwd: request.cwd,
  env,
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
  ...(request.backendHints?.heartbeat === true
    ? {
        ipc: (message: unknown) => {
          if (isHeartbeatMessage(message)) {
            emit(state, { kind: "heartbeat", workerId: request.workerId, at: Date.now() });
          }
        },
      }
    : {}),
});
```

`isHeartbeatMessage` is a private type-guard: `typeof msg === "object" && msg !== null && (msg as { koi?: unknown }).koi === "heartbeat"`. Non-heartbeat IPC messages are ignored (forward-compat slot for future control messages).

### 5.4 Pure helper — `deriveStatus` (~10 LOC)

```typescript
function deriveStatus(m: SupervisorHealthMetrics): {
  readonly status: SupervisorHealthStatus;
  readonly reasons: readonly string[];
} {
  if (m.shuttingDown) return { status: "unhealthy", reasons: ["shutting_down"] };
  const reasons: string[] = [];
  if (m.quarantinedCount > 0) reasons.push("quarantined_workers");
  if (m.eventDropCount > 0) reasons.push("event_buffer_drops");
  if (m.poolSize + m.pendingSpawnCount >= m.maxWorkers) reasons.push("at_capacity");
  return { status: reasons.length > 0 ? "degraded" : "ok", reasons };
}
```

## 6. Data flow

### 6.1 Happy path

```
start(req, backendHints:{heartbeat:true})
  → performSpawn → backend.spawn(req) with ipc handler
  → pool admits worker
  → healthMonitor.track(id, agentId, config.heartbeat ?? DEFAULT)
      state.lastHeartbeatAt = now(); state.deadlineAt = now() + timeoutMs
      state.timer = setTimeout(onDeadline(id), timeoutMs)

child runtime: process.send({ koi: "heartbeat" })
  → backend ipc handler emits WorkerEvent{heartbeat}
  → supervisor watch loop:
     publishEvent(ev); if ev.kind === "heartbeat" → healthMonitor.observe(id)
        clearTimeout(state.timer)
        state.lastHeartbeatAt = now(); state.deadlineAt = now() + timeoutMs
        state.timer = setTimeout(onDeadline(id), timeoutMs)

child exits normally:
  → backend emits WorkerEvent{exited}
  → watch loop → publishEvent + healthMonitor.untrack(id)
```

### 6.2 Timeout path

```
[no heartbeat for timeoutMs] → onDeadline(id) fires
  1. publishEvent({kind:"crashed", workerId:id, at:now(), error:{code:"HEARTBEAT_TIMEOUT", ...}})
  2. void deps.teardown(id, "heartbeat-timeout")
     → supervisor.stop(id, "heartbeat-timeout")
     → entry.stopping = true (blocks watch-loop restart)
     → teardownWorker: terminate → deadline → kill
  3. Real process exit produces real WorkerEvent{exited}
     → watch loop → publishEvent + healthMonitor.untrack(id)
```

Synthetic `crashed` event is for observers/watchAll; it does not drive restart (that's gated on `entry.stopping`). Auto-restart after heartbeat timeout is out of scope (D7).

### 6.3 Shutdown path

`supervisor.shutdown()` already sets `shuttingDown=true`, wakes restart tasks, drains pool and quarantine. Addition: after those steps, call `healthMonitor.shutdown()` to `clearTimeout` every pending deadline timer. Prevents stray `onDeadline` firing into a torn-down supervisor.

### 6.4 Read path — `health()`

Pure synchronous read; no mutation, no await. Called directly by TUI/CLI/tests/future HTTP wrapper.

## 7. Error handling

| Situation | Behavior |
|---|---|
| Child sends non-heartbeat IPC message | Ignored silently by `isHeartbeatMessage` guard (forward-compat) |
| `process.send` fails in child | Child's concern; missed heartbeat → timeout fires |
| `teardown` from `onDeadline` throws | Swallowed via `swallowError`; existing watch-fault quarantine path is the backstop |
| `track` called twice for same id | Second call clears old timer and replaces state (upstream `activeIds` prevents duplicate start anyway) |
| `observe` for untracked id | No-op |
| `onDeadline` fires after `untrack` (timer race) | Guard: `if (!state.has(id)) return` — fires `clearTimeout` does best-effort, we belt-and-suspend |
| `onDeadline` fires during `shuttingDown` | Guard: if `shuttingDown`, skip teardown; just return |
| `agentId` missing for restarting/quarantined workers | Prerequisite in §5.2 plumbs `agentId` into both private entry types; `WorkerHealth.agentId` is always well-typed. No `as` assertions needed |

## 8. Testing plan

### 8.1 Unit — `health-monitor.test.ts`

Inject fake `now()`, fake `publishEvent`, fake `teardown`. Use `bun:test` with `setTimeout`/`setInterval` real timers (tests are fast) or `jest.useFakeTimers()` alternative if Bun exposes it.

- `track` arms timer; timeout fires after `timeoutMs` with no `observe`
- `observe` resets deadline; no timeout within window
- `untrack` clears timer
- `shutdown` clears all timers
- Timeout publishes synthetic `crashed` with `code: "HEARTBEAT_TIMEOUT"`
- Timeout calls `teardown(id, "heartbeat-timeout")`
- `snapshot` returns current state per tracked worker
- Double `track` on same id replaces state
- `observe` on untracked id no-ops
- `teardown` promise rejection is swallowed, not thrown

### 8.2 Integration — `heartbeat-subprocess.test.ts`

Real `Bun.spawn`. Small fixture scripts live inline in test (Bun supports `inline` `Bun.spawn` of `bun -e '...'`).

- Bun child that sends IPC `{koi:"heartbeat"}` every 100ms over a 500ms window; assert `health()` reports advancing `lastHeartbeatAt`, `status === "ok"`.
- Bun child that never sends heartbeat; assert worker is killed at timeout; pool shrinks.
- Bun child that sends 3 heartbeats then stops; assert worker is killed at next timeout window.

### 8.3 Supervisor — additions to `supervisor.test.ts`

- `health()` on fresh supervisor → `status: "ok"`, empty workers
- `health()` with pool at maxWorkers → `status: "degraded"`, reasons contains `"at_capacity"`
- `health()` during `shuttingDown` → `status: "unhealthy"`, reasons `["shutting_down"]`
- `health()` with non-heartbeat-opted worker → worker appears with `lastHeartbeatAt: undefined`
- Full E2E: heartbeat-opt-in worker → 3 heartbeats through watch loop → `health()` `lastHeartbeatAt` strictly increases

### 8.4 Golden — `@koi/runtime` wiring

Add to `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:

- `Golden: @koi/daemon heartbeat health` — spawn Bun subprocess that sends 3 IPC heartbeats, call `supervisor.health()` between each, assert `lastHeartbeatAt` strictly increases, `status === "ok"`.
- `Golden: @koi/daemon heartbeat timeout` — spawn Bun subprocess that ignores heartbeats, wait past `timeoutMs`, assert worker cleaned from `health()`, `supervisor.list()` excludes it.

These are LLM-free standalone tests. `@koi/daemon` is already a runtime dep (from #1338), so only the test additions + golden query config entries are needed.

### 8.5 Coverage

80% lines/functions/statements enforced by `bunfig.toml` — inherits from repo default.

## 9. File-by-file plan summary

| File | Change | LOC |
|---|---|---|
| `packages/kernel/core/src/daemon.ts` | Add `HeartbeatConfig`, `DEFAULT_HEARTBEAT_CONFIG`, `SUPERVISOR_HEALTH_STATUS`, `SupervisorHealthStatus`, `WorkerHealth`, `SupervisorHealthMetrics`, `SupervisorHealth`; extend `SupervisorConfig.heartbeat`; extend `Supervisor.health()` | +40 |
| `packages/kernel/core/src/index.ts` | Export new types + constants | +10 |
| `packages/net/daemon/src/health-monitor.ts` | NEW — factory + timer-driven deadline logic | +180 |
| `packages/net/daemon/src/create-supervisor.ts` | Plumb `agentId` into `RestartingEntry` + `QuarantinedEntry`; instantiate monitor; call `track`/`observe`/`untrack`/`shutdown` at four points; add `health()` method | +50 |
| `packages/net/daemon/src/subprocess-backend.ts` | Opt-in IPC wiring, `isHeartbeatMessage` guard | +30 |
| `packages/net/daemon/src/index.ts` | Export `createHealthMonitor` (useful for custom backends) + type | +2 |
| `packages/net/daemon/src/__tests__/health-monitor.test.ts` | NEW — 10 unit tests | +180 |
| `packages/net/daemon/src/__tests__/heartbeat-subprocess.test.ts` | NEW — 3 integration tests | +80 |
| `packages/net/daemon/src/__tests__/supervisor.test.ts` | +5 tests for `health()` + heartbeat wiring | +100 |
| `docs/L2/daemon.md` | Document heartbeat protocol, IPC message shape, child-side pattern, `health()` return shape | +90 |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` | +2 golden describes | +50 |
| `scripts/layers.ts` | No change — `daemon.ts` already allowlisted | 0 |

**Production LOC total:** ~300 (within budget). Tests/docs do not count against the LOC target.

## 10. CI gate

All existing gates must pass:
- `bun run test`
- `bun run typecheck`
- `bun run lint`
- `bun run check:layers`
- `bun run check:orphans`
- `bun run check:unused`
- `bun run check:duplicates`
- `bun run check:doc-gate`
- `bun run check:golden-queries`

No new CI checks introduced.

## 11. Security + anti-leak checklist

- [x] `@koi/core` still imports-free — only types + pure constants + pure validator added
- [x] No vendor framework types in L0 or L1 (Bun.spawn usage confined to L2 subprocess-backend)
- [x] `backendHints` stays `JsonObject` — heartbeat opt-in is a value, not a new field
- [x] No secrets in IPC protocol — heartbeat message is `{ koi: "heartbeat" }`, nothing more
- [x] Child-side IPC handler validates message shape (`isHeartbeatMessage`) before acting
- [x] All new interface properties `readonly`
- [x] All array params / return types `readonly`
- [x] Timeout timers cleared on shutdown — no leaked handles

## 12. Deferred work

- **Auto-restart after heartbeat timeout** — caller can wrap `stop()` themselves today; promote to first-class config only if multiple callers want it.
- **Non-subprocess backend heartbeat transport** — in-process/tmux/remote backends define their own heartbeat mechanisms in follow-up issues; the L0 `HeartbeatConfig` + `WorkerEvent.heartbeat` contract is backend-agnostic already.
- **HTTP health endpoint** — add a thin `@koi/daemon-http` sidecar package if/when external probes (k8s, load balancers) become a requirement.
- **Child-side heartbeat helper** — extract if the `process.send?.({ koi: "heartbeat" })` pattern appears in 3+ places (Rule of Three).
- **Heartbeat histogram / jitter metrics** — useful for observability but out of scope; `onAnomaly`-style hooks land in a future observability-focused issue.

## 13. Open questions resolved during brainstorm

Q1 Health endpoint scope → A (in-memory only). D1.
Q2 Subprocess heartbeat transport → A (Bun IPC). D2.
Q3 Missed-heartbeat reaction → A (synthetic crash + teardown, no new event kind). D3.
Q4 Config placement → A (global `SupervisorConfig.heartbeat` + per-spawn opt-in flag). D4.
Q5 Self-health schema → A (3-state ladder + raw metrics). D5.
