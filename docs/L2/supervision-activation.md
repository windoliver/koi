# Supervision Activation — 3b-5

> Status: in-process (3b-5a) + subprocess (3b-5c) isolation both functional.
> IPC envelope (3b-5b) is available for worker bootstraps that need it.

## What this enables

A manifest may declare a supervision tree:

```yaml
supervision:
  strategy: { kind: one_for_one }
  maxRestarts: 5
  maxRestartWindowMs: 60000
  children:
    - name: researcher
      restart: transient
      isolation: in-process
```

When the supervising agent is registered in an `AgentRegistry` and paired with
`wireSupervision(...)`, the subsystem activates automatically: crashed
supervised children are restarted per the declared strategy; budget
exhaustion escalates the supervisor.

## What 3b-5a delivers

- L0 schema: `ChildSpec.isolation?: "in-process" | "subprocess"`, default
  `"in-process"`. Validator `validateSupervisionConfig` in `@koi/core`.
- `createInProcessSpawnChildFn({ registry, spawn })` — adapter that routes
  the reconciler's `SpawnChildFn` call to a caller-provided delegate and
  warns when `metadata.childSpecName` is missing.
- `wireSupervision({ registry, manifests, spawnChild })` — composition
  helper that builds ProcessTree → SupervisionReconciler → CascadingTermination
  → ReconcileRunner in the one order that works, plus a supervisor-aware
  watch bridge so supervisors react on the fast path (not just via the 30s
  drift sweep).
- Event-driven restarts (no 30s wait): the watch bridge enqueues the
  supervisor whenever a supervised child transitions.
- Integration tests covering all three strategies (`one_for_one`,
  `one_for_all`, `rest_for_one`), budget-exhaustion escalation, and dispose
  idempotency.

## Canonical caller pattern

```typescript
import { agentId, type AgentManifest } from "@koi/core";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import {
  createInProcessSpawnChildFn,
  wireSupervision,
  spawnChildAgent,
} from "@koi/engine";

// 1. Build or receive the registry and the supervisor manifest.
const registry = createInMemoryRegistry();
const supervisorId = agentId("my-supervisor");
const manifest: AgentManifest = {
  name: "supervisor",
  version: "1.0.0",
  model: { name: "gpt-4" },
  supervision: {
    strategy: { kind: "one_for_one" },
    maxRestarts: 5,
    maxRestartWindowMs: 60_000,
    children: [{ name: "worker", restart: "transient", isolation: "in-process" }],
  },
};

// 2. Build the in-process SpawnChildFn. The delegate calls into L1's
//    spawnChildAgent (or your own in-process spawn surface).
const spawnChild = createInProcessSpawnChildFn({
  registry,
  spawn: async (parentId, childSpec, childManifest) => {
    const result = await spawnChildAgent({
      parentAgent: /* ... */,
      manifest: childManifest,
      adapter: /* ... */,
      registry,
      metadata: { childSpecName: childSpec.name },
      /* ...other SpawnChildOptions */
    });
    return result.childId;
  },
});

// 3. Wire supervision. ProcessTree subscribes to registry.watch BEFORE the
//    supervisor is registered, so it must be created first.
const wiring = wireSupervision({
  registry,
  manifests: new Map([[supervisorId, manifest]]),
  spawnChild,
});

// 4. Register the supervisor. This triggers the first reconcile, which
//    initializes the child map and spawns initial children.
registry.register({
  agentId: supervisorId,
  status: {
    phase: "running",
    generation: 0,
    conditions: [],
    reason: { kind: "assembly_complete" },
    lastTransitionAt: Date.now(),
  },
  agentType: "worker",
  metadata: {},
  registeredAt: Date.now(),
  priority: 10,
});

// 5. On shutdown, dispose in a deterministic order.
await wiring[Symbol.asyncDispose]();
```

## 3b-5b — IPC envelope

`WorkerIpcMessage` (`@koi/core/worker-ipc`) is a discriminated union over
`{ koi: "heartbeat" | "engine-event" | "message" | "terminate" | "result" }`
that worker bootstraps can use for parent↔child messaging. The envelope is
validated via `validateWorkerIpcMessage(raw)`; the exact bootstrap script is
left to each deployment (the daemon adapter accepts an arbitrary
`commandBuilder`, so callers can point at whichever worker entrypoint their
runtime ships).

## 3b-5c — Subprocess isolation

For `childSpec.isolation: "subprocess"`, compose the daemon-backed
`SpawnChildFn` with the in-process adapter via `createDispatchingSpawnChildFn`:

```typescript
import { agentId, type AgentManifest } from "@koi/core";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import {
  createDispatchingSpawnChildFn,
  createInProcessSpawnChildFn,
  wireSupervision,
  spawnChildAgent,
} from "@koi/engine";
import {
  attachAgentRegistry,
  attachRegistry,
  createDaemonSpawnChildFn,
  createFileSessionRegistry,
  createSubprocessBackend,
  createSupervisor,
} from "@koi/daemon";

const agentRegistry = createInMemoryRegistry();
const sessionRegistry = createFileSessionRegistry({ dir: "/var/koi/sessions" });

const supResult = createSupervisor({
  maxWorkers: 16,
  shutdownDeadlineMs: 5_000,
  backends: { subprocess: createSubprocessBackend() },
});
if (!supResult.ok) throw new Error("supervisor init failed");
const supervisor = supResult.value;

// Two bridges: one mirrors worker events into the file-backed session
// registry (for `koi bg ps` visibility); the other mirrors the same events
// into the AgentRegistry so the supervision reconciler can observe child
// lifecycles through its usual level-triggered loop.
const sessionBridge = attachRegistry({ supervisor, registry: sessionRegistry });
const agentBridge = attachAgentRegistry({ supervisor, agentRegistry });

const subprocessSpawn = createDaemonSpawnChildFn({
  supervisor,
  sessionRegistry,
  agentRegistry,
  bridge: agentBridge,
  commandBuilder: (_parent, _child, manifest) => [
    "bun",
    "run",
    "./workers/supervised-worker.ts",
    "--manifest", JSON.stringify(manifest),
  ],
  logDir: "/var/koi/logs",
});

const inProcessSpawn = createInProcessSpawnChildFn({
  registry: agentRegistry,
  spawn: async (parentId, childSpec, childManifest) => {
    const result = await spawnChildAgent({
      parentAgent: /* ... */,
      manifest: childManifest,
      adapter: /* ... */,
      registry: agentRegistry,
      metadata: { childSpecName: childSpec.name },
    });
    return result.childId;
  },
});

const supervisorId = agentId("root-supervisor");
const manifest: AgentManifest = {
  name: "hybrid-supervisor",
  version: "1.0.0",
  model: { name: "gpt-4" },
  supervision: {
    strategy: { kind: "one_for_one" },
    maxRestarts: 5,
    maxRestartWindowMs: 60_000,
    children: [
      { name: "fast-child", restart: "transient", isolation: "in-process" },
      { name: "crashy-worker", restart: "permanent", isolation: "subprocess" },
    ],
  },
};

const wiring = wireSupervision({
  registry: agentRegistry,
  manifests: new Map([[supervisorId, manifest]]),
  spawnChild: createDispatchingSpawnChildFn({
    inProcess: inProcessSpawn,
    subprocess: subprocessSpawn,
  }),
});

// Register the supervisor → first reconcile spawns both children through
// their respective isolation paths.
agentRegistry.register({
  agentId: supervisorId,
  status: {
    phase: "running",
    generation: 0,
    conditions: [],
    reason: { kind: "assembly_complete" },
    lastTransitionAt: Date.now(),
  },
  agentType: "worker",
  metadata: {},
  registeredAt: Date.now(),
  priority: 10,
});

// On shutdown: dispose in reverse construction order.
await wiring[Symbol.asyncDispose]();
await agentBridge.close();
await sessionBridge.close();
await supervisor.shutdown("shutdown");
```

The subprocess path also enables:
- `koi bg ps` listings of supervised subprocess workers.
- 24h terminal-record retention with opportunistic sweep (`registry-supervisor-bridge.ts`).
- `koi bg ps --all` to include stale post-mortems older than the window.

## Known follow-ups

- Reconciler's `applyOneForOne` counts the initial spawn as a restart
  attempt. Setting `maxRestarts: N` yields `N-1` observable restarts
  before escalation. Worth a semantics pass or doc note on
  `SupervisionConfig`.
- `wireSupervision`'s supervisor-aware watch bridge uses
  `reconcileRunner.sweep()` to re-enqueue all running agents on each
  supervised transition. A future refinement could enqueue only the
  specific parent via a new runner API.

## References

- Spec: `docs/superpowers/specs/2026-04-21-v2-3b-5-supervision-wiring-design.md`
- Plan: `docs/superpowers/plans/2026-04-21-v2-3b-5a-supervision-wiring.md`
- Issue: [#1866](https://github.com/windoliver/koi/issues/1866)
- Integration test (in-process): `packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts`
- Integration test (subprocess): `packages/net/daemon/src/__tests__/subprocess-supervision.integration.test.ts`
- Reconciler: `packages/kernel/engine-reconcile/src/supervision-reconciler.ts`
- L0 schema: `packages/kernel/core/src/supervision.ts`
- IPC envelope: `packages/kernel/core/src/worker-ipc.ts`
- Daemon adapter: `packages/net/daemon/src/daemon-spawn-child-fn.ts`
- Agent-registry bridge: `packages/net/daemon/src/agent-registry-bridge.ts`
- Dispatching adapter: `packages/kernel/engine/src/dispatching-spawn-child-fn.ts`
