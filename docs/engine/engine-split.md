# Engine Split: 3-Package Architecture

`@koi/engine` was split into three focused L1 packages to improve build
isolation, reduce rebuild scope, and clarify ownership boundaries.

**Layer**: L1
**Packages**: `@koi/engine-compose`, `@koi/engine-reconcile`, `@koi/engine`
**Issue**: #871

---

## Motivation

The original `@koi/engine` was a monolithic 8K LOC package spanning three
distinct concerns: middleware composition, reconciliation/supervision, and
factory/lifecycle. Any change to reconciliation triggered a full rebuild of
composition code and vice versa. The split delivers:

- **Faster builds** — changing a reconciliation controller no longer rebuilds
  the middleware chain compositor (and vice versa). Turborepo caches each
  package independently.
- **Clearer ownership** — each package has a single responsibility with a
  well-defined surface area.
- **Smaller dependency footprint** — `engine-compose` and `engine-reconcile`
  are leaf packages with no L1 dependencies, only L0 + L0u.
- **Zero breaking changes** — `@koi/engine` barrel re-exports everything from
  both new packages. The 50+ downstream consumers import from `@koi/engine`
  unchanged.

## Package Dependency Graph

```
@koi/engine-compose    (L1 leaf — L0 + L0u only)
@koi/engine-reconcile  (L1 leaf — L0 + L0u only)
         │                       │
         └──────┬────────────────┘
                ▼
          @koi/engine      (L1 — depends on both + L0 + L0u)
```

Both new packages are **leaf L1 packages**: they depend only on L0 (`@koi/core`)
and L0u utilities (`@koi/errors`, `@koi/hash`, `@koi/session-repair`,
`@koi/event-delivery`). They never depend on each other or on `@koi/engine`.

## What Lives Where

### `@koi/engine-compose` — Middleware Composition & Guards

Pure functions for assembling the middleware onion. No state, no I/O.

| Module | Purpose |
|--------|---------|
| `compose.ts` | `composeModelChain`, `composeToolChain`, `runSessionHooks`, `runTurnHooks`, `injectCapabilities`, `recomposeChains` |
| `guards.ts` | `createIterationGuard`, `createLoopDetector`, `createSpawnGuard` |
| `extension-composer.ts` | `composeExtensions`, `createDefaultGuardExtension`, `isSignificantTransition` |
| `visibility-filter.ts` | `createVisibilityFilter` for depth-based tool restriction |
| `guard-types.ts` | `IterationLimits`, `SpawnPolicy`, `LoopDetectionConfig` + defaults |

**Dependencies**: `@koi/core`, `@koi/errors`, `@koi/hash`, `@koi/session-repair`

### `@koi/engine-reconcile` — Reconciliation & Supervision

Controllers, process management, and registry. The systemd-like supervision layer.

| Module | Purpose |
|--------|---------|
| `reconcile-runner.ts` | Tick-based reconciliation loop with circuit breakers |
| `reconcile-queue.ts` | Priority queue for reconciliation targets |
| `supervision-reconciler.ts` | one_for_one, one_for_all, rest_for_one strategies |
| `health-monitor.ts` / `health-reconciler.ts` | Heartbeat tracking + health checks |
| `timeout-reconciler.ts` | Deadline enforcement |
| `tool-reconciler.ts` | Tool drift detection |
| `governance-*.ts` | Governance controller, extension, provider, reconciler |
| `cascading-termination.ts` | BFS cascade with copilot subtree pruning |
| `process-tree.ts` | Parent-child ancestry tracking |
| `process-accounter.ts` | Process count accounting |
| `concurrency-guard.ts` / `concurrency-semaphore.ts` | Concurrency limiting |
| `eviction-policies.ts` | LRU and QoS eviction |
| `registry.ts` | In-memory `AgentRegistry` implementation |
| `transitions.ts` | CAS state machine validation |
| `clock.ts` / `backoff.ts` / `rolling-window.ts` | Shared infrastructure |
| `governance-types.ts` | `GovernanceConfig`, `InMemoryRegistry` type, defaults |

**Dependencies**: `@koi/core`, `@koi/errors`, `@koi/event-delivery`

### `@koi/engine` — Factory, Lifecycle & Bridge

The assembly factory (`createKoi`), agent entity, lifecycle state machine,
and bridge functions that connect composition to the entity system.

| Module | Purpose |
|--------|---------|
| `koi.ts` | `createKoi` factory — the primary entry point |
| `agent-entity.ts` | `AgentEntity` — ECS entity with component storage |
| `lifecycle.ts` | Lifecycle state machine (created→running→terminated) |
| `compose-bridge.ts` | `createTerminalHandlers`, `createComposedCallHandlers` — lifecycle-aware terminals |
| `spawn-child.ts` | `spawnChildAgent` — child agent orchestration |
| `registry.ts` | Re-exported from engine-reconcile |
| `delivery-policy.ts` | Message delivery policy application |
| Other modules | spawn-ledger, child-handle, group-operations, inherited-channel, etc. |

**Dependencies**: `@koi/engine-compose`, `@koi/engine-reconcile`, `@koi/core`, L0u packages

## What This Enables

### For Day-to-Day Development

- **Edit a guard** → only `engine-compose` rebuilds. `engine-reconcile` is
  cached. Total rebuild time drops proportionally.
- **Edit a reconciler** → only `engine-reconcile` rebuilds. Middleware
  composition code is untouched.
- **Turborepo caching** — each package has its own cache key. The most common
  edit patterns (guard tuning, reconciler fixes) now hit smaller cache scopes.

### For Future Architecture

- **Independent versioning** — if the monorepo later publishes packages,
  compose and reconcile can version independently.
- **Selective testing** — `turbo run test --filter=@koi/engine-compose` runs
  only composition tests (~50 tests) instead of the full 750+ engine suite.
- **Clearer code review** — PRs that touch only reconciliation have a smaller
  blast radius and can be reviewed by the supervision-domain expert alone.

### For Downstream Consumers

- **Nothing changes** — all imports from `@koi/engine` continue to work.
  The barrel `index.ts` re-exports everything from both sub-packages.
- **Optional direct imports** — consumers that want tighter dependency control
  can import directly from `@koi/engine-compose` or `@koi/engine-reconcile`.

## Error Handling Improvements

As part of this split, 7 fire-and-forget promise sites were fixed with proper
`.catch()` handlers:

| File | Site | Fix |
|------|------|-----|
| `cascading-termination.ts` | `void cascadeTerminate(...)` | `.catch()` with agent ID context |
| `reconcile-runner.ts` | `void listed.then(...)` (drift sweep) | `.catch()` with structured log |
| `reconcile-runner.ts` | `void listed.then(...)` (enqueue) | `.catch()` with structured log |
| `koi.ts` | forge watch `.catch(() => {})` | `console.warn` instead of silent swallow |
| `spawn-child.ts` | `void childRuntime.dispose()` | `.catch()` with child PID context |
| `spawn-child.ts` | `void parentDel.revoke(...)` | `.catch()` with child PID context |
| `supervision-reconciler.ts` | `void result` (async terminate) | `.catch()` with child ID context |

## Layer Rules

The layer checker (`scripts/check-layers.ts`) was updated to allow L1→L1
dependencies. Turborepo's task graph catches actual cycles; the layer checker
validates layer boundaries only.

```
L1 allowed deps = L0 + L0u + L1 (peer L1 packages)
```

Both new packages are registered in `scripts/layers.ts` under `L1_PACKAGES`.
