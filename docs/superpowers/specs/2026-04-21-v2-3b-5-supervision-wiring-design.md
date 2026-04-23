# v2 Phase 3b-5 — Supervision Activation: Design Decisions

**Issue:** [#1866](https://github.com/windoliver/koi/issues/1866) — activate supervision subsystem in runtime (reconciler + daemon wiring)
**Status:** design-decisions; implementation split into 3 sub-issues (3b-5a, 3b-5b, 3b-5c)
**Date:** 2026-04-21

## 1. Context

Koi ships two fully-built supervision subsystems that are never instantiated in production:

- `ReconcileRunner` + `SupervisionReconciler` + `ProcessTree` in `@koi/engine-reconcile`
- `@koi/daemon` `Supervisor` + `createSubprocessBackend` + `attachRegistry` + `createFileSessionRegistry`

A manifest can declare `supervision:` — but the runtime ignores it. `@koi/daemon` has no consumer. `koi bg ps/logs/kill` always returns empty.

This document records the design decisions that unblock wiring everything into the runtime. It does not specify implementation detail beyond what is needed to distinguish sub-issue scope; each sub-issue gets its own plan cycle.

## 2. The 7 Decisions

### D1 — IPC wire format (direction only; not implemented in 3b-5)

Subprocess-isolated supervised children communicate with their parent via **Bun IPC + a JSON envelope**. Messages are type-tagged: `{ koi: "heartbeat" }`, `{ koi: "engine-event", event }`, `{ koi: "message", payload }`, `{ koi: "terminate" }`, `{ koi: "result", ... }`. Extends the existing heartbeat channel in `@koi/daemon`'s subprocess backend. Zero new deps; Bun-native.

Remote and tmux backends are future L2 packages and will negotiate their own transport.

### D2 — `isolation` lives on `ChildSpec`

```typescript
interface ChildSpec {
  readonly name: string;
  readonly restart: RestartType;
  readonly shutdownTimeoutMs?: number;
  readonly isolation?: "in-process" | "subprocess"; // default "in-process"
}
```

Per-child granularity matches Erlang `ChildSpec`. Default `"in-process"` means existing manifests need no migration (but note: any manifest that currently declares `supervision:` has been dead code until this issue lands — after 3b-5a it starts actually supervising in-process). One supervisor can mix cheap in-process coordinators with OS-isolated expensive children.

### D3 — Runtime owns a single `ProcessTree`

The runtime bootstrap instantiates one `ProcessTree(registry)` and shares it with both `SupervisionReconciler` and `CascadingTermination`. Single `registry.watch()` subscription; single parent/child map; no drift risk.

### D4 — Reconcile trigger: event-driven + 30s drift sweep

`ReconcileRunner` is configured with `driftCheckIntervalMs: 30_000`. Event-driven path via `registry.watch()` handles the happy path in <10ms; the sweep is a safety net against lost events or edge transitions. Matches k8s/systemd convention. Dedup is already handled inside `ReconcileRunner`'s queue.

### D5 — Strict registration order in bootstrap

A new helper `wireSupervision({ registry, manifests, daemon? })` in `@koi/runtime` performs the following in order:

1. Create `ProcessTree(registry)`
2. Create `SupervisionReconciler({ registry, processTree, spawnChild })`
3. Create `CascadingTermination({ processTree, isSupervised: reconciler.isSupervised })`
4. `runner.register(reconciler)` then `runner.register(cascading)`
5. `runner.start()`

This eliminates the TOCTOU between cascading-termination and reconciliation. A contract test asserts ordering.

### D6 — Escalation: registry-only + propagate-up

When restart budget is exhausted, the reconciler transitions the supervisor's entry in `AgentRegistry` to `terminated` with reason `{ kind: "escalated", cause }`. It does not call into the daemon. Two consequences:

- The supervisor's own parent (if any) sees the transition via its reconciler and restarts per its policy — true Erlang OTP tree recovery.
- The daemon's subprocess adapter watches the registry; when the logical agent goes `terminated`, the adapter calls `supervisor.stop(workerId)` to kill the Bun subprocess. Layer boundary preserved: the reconciler (L1) never knows about OS processes.

### D7 — Registry retention: 24h + opportunistic on-write sweep

Terminal entries (`exited` / `crashed`) stay in `BackgroundSessionRegistry` for 24h. The `registry-supervisor-bridge.ts` sweep runs **on every terminal status update** (opportunistic): scan entries, unregister any with `endedAt < now - 24h`. No dedicated sweeper process; amortized cost is trivial.

CLI:
- `koi bg ps` — default filter: non-terminal + terminal-within-24h
- `koi bg ps --all` — everything still on disk
- `koi bg prune` — manual immediate cleanup (future)

## 3. Architecture

```
L0 @koi/core
  ├─ SupervisionConfig / ChildSpec (schema + validator; D2)
  └─ AgentRegistry (CAS + watch)                        ← source of truth

L1 @koi/engine-reconcile
  ├─ ProcessTree (subscribes registry.watch)            ← parent/child map
  ├─ ReconcileRunner (event-driven + 30s sweep; D4)     ← orchestrator
  ├─ SupervisionReconciler (Erlang restart strategies)
  └─ CascadingTermination (skips isSupervised children)

L2 @koi/daemon
  ├─ Supervisor (pool, backend, restart backoff)
  ├─ createSubprocessBackend (Bun.spawn + Bun IPC; D1)
  └─ attachRegistry (supervisor events → registry; D7 sweep)

L3 @koi/runtime (bootstrap wiring — this issue)
  └─ wireSupervision({ registry, manifests, daemon? })  ← D5 order
```

**SpawnChildFn wiring** — the point where the four layers meet:

```
reconciler needs to (re)spawn a child
  → spawnChild(parentId, childSpec, manifest)
  → adapter branches on childSpec.isolation (D2):
      "in-process"  → delegates to spawnChildAgent / createAgentSpawnFn (engine)
      "subprocess"  → registry.register(...) then supervisor.start({
                        command: ["bun", "<worker.ts>", "--manifest", serialized],
                        backendHints: { logPath, heartbeat: true },
                      })
  → sets entry.metadata.childSpecName for robust match
  → returns new AgentId
```

## 4. Sub-Issue Decomposition (Option B — 3 sub-issues)

### 3b-5a — Runtime activation (in-process only)

**Scope:**
- L0 schema: add `ChildSpec.isolation?` + validator update (D2)
- New helper `wireSupervision(...)` in `@koi/runtime` (D3, D5)
- In-process `SpawnChildFn` adapter delegating to `spawnChildAgent` / `createAgentSpawnFn`; sets `metadata.childSpecName`
- `createRuntime` calls `wireSupervision` when any loaded manifest has `supervision?` set
- `ReconcileRunner` configured with `driftCheckIntervalMs: 30_000` (D4)
- Integration tests: auto-wire, transient abnormal exit restart, `one_for_one` / `one_for_all` / `rest_for_one` end-to-end, budget exhaustion escalation, nested supervisors (propagate-up per D6), graceful shutdown order

**LOC estimate:** ~400–500

**Delivers standalone value:** `manifest.supervision` becomes live for in-process agents. No daemon dependency.

**Dependencies:** none.

### 3b-5b — IPC envelope + worker bootstrap

**Scope:**
- New L0 type: `WorkerIpcMessage` discriminated union (D1) + validator
- New file `packages/net/daemon/bin/worker.ts`: child subprocess entry. Reads serialized manifest from argv, calls `createKoi`, relays `EngineEvent` stream via `process.send({ koi: "engine-event", event })`, listens for parent→child messages via `process.on("message", ...)`
- Extend `createSubprocessBackend`: parse IPC messages beyond heartbeat; expose `onMessage`/`send` on `WorkerHandle`
- Unit tests: envelope validation, bad-shape rejection, worker bootstrap with a fake manifest, round-trip serialization
- No runtime wiring yet — pure infra

**LOC estimate:** ~300–400

**Delivers:** the transport. No user-visible change.

**Dependencies:** 3b-5a merged (consumes `ChildSpec.isolation` schema).

### 3b-5c — Daemon-backed `SpawnChildFn` + registry population + sweep

**Scope:**
- Subprocess `SpawnChildFn` adapter: translates `AgentManifest` → `WorkerSpawnRequest.command = ["bun", "<worker.ts>", "--manifest", <serialized>]`; sets `metadata.childSpecName`; pre-registers session via `registry.register(...)`; calls `supervisor.start(..., { backendHints: { logPath, heartbeat: true } })`
- `wireSupervision` extended to accept `{ daemon?: { supervisor, registry } }`; the dispatching `SpawnChildFn` routes per `childSpec.isolation`
- `attachRegistry({ supervisor, registry })` called once at wire time; bridge lifetime tied to runtime dispose
- 24h opportunistic on-write sweep in `registry-supervisor-bridge.ts` (D7)
- `koi bg ps` default filter (D7) — `--all` bypasses
- Parent-supervisor propagate-up (D6): daemon adapter subscribes to `registry.watch()`; when the supervisor agent's entry transitions to `terminated`, calls `supervisor.stop(workerId)`
- Integration tests: subprocess crash → reconciler restart → daemon respawns → registry reflects new workerId; `koi bg ps --registry-dir <test>` hides >24h; escalation kills subprocess; graceful shutdown order: `bridge.close()` → `supervisor.shutdown()` → runner dispose

**LOC estimate:** ~500–600

**Dependencies:** 3b-5a + 3b-5b merged.

### Dependency graph

```
3b-5a  (no dep)  ─┐
                  ├── both merged → 3b-5c
3b-5b  (no dep)  ─┘
```

3b-5a and 3b-5b are independent and can be worked in parallel.

## 5. Testing & Rollout

**Testing layers:**

| Layer | Where | What |
|-------|-------|------|
| Unit | per-package | schema validators (`ChildSpec.isolation`, `WorkerIpcMessage`), sweep threshold math |
| Contract | `packages/meta/runtime/__tests__/` | `wireSupervision` composition — right deps, right order, reverse dispose |
| Integration | `packages/meta/runtime/__tests__/` | manifest → live reconciler → crash → restart (all 3 strategies), escalation propagate-up, nested supervisors |
| Subprocess E2E | 3b-5c | real `Bun.spawn` subprocess, IPC round-trip, `koi bg ps` via file registry, 24h sweep |
| Golden query | `@koi/runtime` | one supervision scenario added to `record-cassettes.ts` |

**Rollout order:**

1. 3b-5a → `manifest.supervision` becomes functional for in-process agents. Behavior change: any existing manifest that already declares `supervision:` begins supervising after this lands (previously silent no-op). Manifests without `supervision:` see no change. Default `isolation: "in-process"` means no schema migration is required.
2. 3b-5b → transport only; no user-visible change.
3. 3b-5c → subprocess isolation works; `koi bg ps/logs/kill` become useful. Users opt in per-child with `isolation: subprocess`.

**Risks:**

- Event-driven + 30s sweep double-reconcile: `ReconcileRunner` queue dedup already covers this; contract test asserts no double-restart under burst.
- Metadata-based child match fallback: both spawn adapters must set `metadata.childSpecName`; covered in 3b-5a and 3b-5c.
- Registry bridge race on shutdown: `bridge.close()` must fire before `supervisor.shutdown()`; wiring owns the order.

## 6. Out of Scope (explicit non-goals for #1866)

- Remote and tmux backends (future L2 packages)
- Sibling-to-sibling message bus (`message` IPC kind reserved but not implemented)
- `AbortSignal` plumbing on `WorkerBackend.watch()` — tracked in #1865
- In-process children appearing in `koi bg ps` — they have no OS pid
- `koi bg prune` manual command — deferred

## 7. References

- Issue [#1866](https://github.com/windoliver/koi/issues/1866) — parent
- Issue [#1338](https://github.com/windoliver/koi/issues/1338) — v2 Phase 3b-1 supervisor + worker management
- Issue [#1340](https://github.com/windoliver/koi/issues/1340) — session registry + `koi bg` CLI
- `packages/kernel/engine-reconcile/src/supervision-reconciler.ts` — restart strategies
- `packages/kernel/engine-reconcile/src/process-tree.ts` — parent/child tracker
- `packages/kernel/engine-reconcile/src/reconcile-runner.ts` — orchestrator
- `packages/net/daemon/src/create-supervisor.ts` — daemon surface
- `packages/net/daemon/src/registry-supervisor-bridge.ts` — D7 sweep location
- `docs/L2/daemon.md` — daemon package doc
- `packages/kernel/core/src/supervision.ts` — L0 Erlang model (D2 schema change target)
