# @koi/autonomous — Coordinated Autonomous Agent Composition

Composes a `LongRunningHarness` + `HarnessScheduler` + optional compactor middleware into a single `AutonomousAgent` with correct disposal ordering and unified middleware collection. The glue layer for true multi-session autonomous operation.

---

## Why It Exists

Three independent packages handle pieces of autonomous operation:

- `@koi/long-running` — multi-session lifecycle (start, pause, resume, complete)
- `@koi/harness-scheduler` — auto-resume when suspended
- `@koi/middleware-compactor` — context window management across sessions

But they don't coordinate. Without a composition layer:

- **Disposal order matters** — scheduler must stop before harness disposes (otherwise scheduler resumes a dead harness)
- **Middleware collection is manual** — caller must remember to include both harness middleware and compactor
- **No single handle** — three separate objects to manage, pass around, and clean up

`@koi/autonomous` provides **a single coordinated facade**:

- **Correct disposal** — scheduler stops first, then harness disposes
- **Unified middleware** — `middleware()` returns harness + compactor in one array
- **Single owner** — one `dispose()` call cleans up everything
- **Idempotent cleanup** — safe to call `dispose()` multiple times

---

## Architecture

`@koi/autonomous` is an **L3 meta-package** — it composes L2 packages without adding new logic.

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/autonomous  (L3)                                            │
│                                                                    │
│  types.ts        ← AutonomousAgentParts, AutonomousAgent           │
│  autonomous.ts   ← createAutonomousAgent() factory (~35 LOC)       │
│  index.ts        ← Public API surface                              │
│                                                                    │
├──────────────────────────────────────────────────────────────────  │
│  Dependencies                                                      │
│                                                                    │
│  @koi/core              (L0)  KoiMiddleware                        │
│  @koi/long-running      (L2)  LongRunningHarness                   │
│  @koi/harness-scheduler (L2)  HarnessScheduler                     │
└──────────────────────────────────────────────────────────────────  ┘
```

### Composition Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  AutonomousAgent                                                  │
│                                                                    │
│  ┌────────────────────────┐  ┌────────────────────────────────┐  │
│  │  LongRunningHarness    │  │  HarnessScheduler               │  │
│  │                        │  │                                  │  │
│  │  start()               │  │  start() → polls harness        │  │
│  │  resume()     ◄────────┤──┤  auto-resumes when suspended    │  │
│  │  pause()               │  │  stop() → graceful stop         │  │
│  │  completeTask()        │  │  dispose() → stop + cleanup     │  │
│  │  fail()                │  │                                  │  │
│  │  status()              │  │                                  │  │
│  │  createMiddleware() ───┤  └────────────────────────────────┘  │
│  │  dispose()             │                                       │
│  └────────────────────────┘                                       │
│                                                                    │
│  middleware() ─────────────────────────────────────────────────── │
│    [0] harness middleware  (long-running-harness)                  │
│    [1] compactor middleware (optional)                             │
│    [2] collective memory middleware (optional)                     │
│    [3] event-trace middleware (optional, priority 475)             │
│    [4] report middleware (optional, priority 275)                  │
│                                                                    │
│  dispose() ────────────────────────────────────────────────────── │
│    1. scheduler.dispose()   ← stop polling first                  │
│    2. harness.dispose()     ← then clean up harness               │
│    (idempotent — safe to call multiple times)                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## How It Works

The factory accepts pre-constructed parts (instance-based pattern) and wires them together:

1. **Middleware caching** — `middleware()` returns a cached array (same reference every call). Built once at construction from `harness.createMiddleware()` + optional compactor.

2. **Disposal ordering** — `dispose()` stops the scheduler first (prevents new `resume()` calls), then disposes the harness. This order prevents a race where the scheduler calls `resume()` on an already-disposed harness.

3. **Idempotent dispose** — a `disposed` flag ensures the cleanup sequence runs exactly once.

```
createAutonomousAgent({ harness, scheduler, compactorMiddleware?, ... })
  │
  ├── cache middleware: [harness.createMiddleware(), checkpoint?, inbox?,
  │                       compactorMiddleware?, collectiveMemoryMiddleware?,
  │                       eventTraceMiddleware?, reportMiddleware?]
  │
  └── return AutonomousAgent {
        harness,            ← direct reference
        scheduler,          ← direct reference
        middleware(),       ← cached array
        dispose(),          ← ordered: scheduler → harness
      }
```

---

## Configuration

The factory takes an `AutonomousAgentParts` object — all parts are pre-constructed:

```typescript
interface AutonomousAgentParts {
  readonly harness: LongRunningHarness;         // Multi-session lifecycle manager
  readonly scheduler: HarnessScheduler;         // Auto-resume polling scheduler
  readonly compactorMiddleware?: KoiMiddleware;  // Optional context compaction
  readonly collectiveMemoryMiddleware?: KoiMiddleware;  // Optional cross-run learning
  readonly reportMiddleware?: KoiMiddleware;     // Optional post-run summaries
  readonly eventTraceMiddleware?: KoiMiddleware;  // Optional per-event tracing + rewind
  readonly threadStore?: ThreadStore;            // Enables checkpoint + inbox middleware
  readonly checkpointPolicy?: CheckpointPolicy; // Override checkpoint frequency
  readonly inboxPolicy?: InboxPolicy;           // Override inbox queue caps
  readonly handoffBridge?: HarnessHandoffBridgeConfig; // Harness-to-handoff bridge
  readonly agentResolver?: AgentResolver;       // Explicit resolver (skips auto-create)
  readonly forgeStore?: ForgeStore;             // Auto-creates CatalogAgentResolver
  readonly healthRecorder?: SpawnHealthRecorder; // Spawn outcome tracking
}
```

Pass `forgeStore` to auto-enable forge-backed agent discovery. Pass `agentResolver` directly to use a custom resolver instead.

---

## Examples

### Minimal — Harness + Scheduler

```typescript
import { createLongRunningHarness } from "@koi/long-running";
import { createHarnessScheduler } from "@koi/harness-scheduler";
import { createAutonomousAgent } from "@koi/autonomous";

const harness = createLongRunningHarness({
  harnessId: harnessId("agent-1"),
  agentId: agentId("agent-1"),
  harnessStore: snapshotStore,
  sessionPersistence,
});

const scheduler = createHarnessScheduler({
  harness,
  pollIntervalMs: 5000,
  maxRetries: 3,
});

const agent = createAutonomousAgent({ harness, scheduler });

// Wire middleware into createKoi
const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [...agent.middleware()],
});

// Start the lifecycle
scheduler.start();
await harness.start(taskPlan);

// ... agent runs autonomously across sessions ...

// Clean shutdown
await agent.dispose();
```

### With Compactor Middleware

```typescript
import { createCompactorMiddleware } from "@koi/middleware-compactor";

const compactor = createCompactorMiddleware({
  maxContextTokens: 8000,
  preserveRecent: 3,
});

const agent = createAutonomousAgent({
  harness,
  scheduler,
  compactorMiddleware: compactor,
});

const mw = agent.middleware();
// mw[0] = long-running-harness middleware
// mw[1] = compactor middleware
```

### With Event-Trace and Report Middleware

```typescript
import { createEventTraceMiddleware } from "@koi/middleware-event-trace";
import { createReportMiddleware } from "@koi/middleware-report";

const eventTrace = createEventTraceMiddleware({
  store: snapshotStore,
  chainId: chainId("agent-1-trace"),
});

const report = createReportMiddleware({
  objective: "Refactor auth module",
  onReport: async (_report, markdown) => {
    await postToSlack("#agent-reports", markdown);
  },
});

const agent = createAutonomousAgent({
  harness,
  scheduler,
  eventTraceMiddleware: eventTrace.middleware,
  reportMiddleware: report.middleware,
});

// After the run:
const runReport = report.getReport();       // Structured post-run summary
const events = await eventTrace             // Query specific events
  .getEventsBetween({ turnIndex: 0, eventIndex: 0 }, { turnIndex: 5, eventIndex: 99 });
```

### Full Stack with SQLite Persistence

```typescript
import { createSqliteSnapshotStore } from "@koi/snapshot-store-sqlite";
import { createLongRunningHarness } from "@koi/long-running";
import { createHarnessScheduler } from "@koi/harness-scheduler";
import { createAutonomousAgent } from "@koi/autonomous";
import { createKoi, createLoopAdapter } from "@koi/engine";
import { createPiAdapter } from "@koi/pi-adapter";

// 1. Persistent storage
const snapshotStore = createSqliteSnapshotStore({
  dbPath: "./data/agent-snapshots.db",
  durability: "os",
});

// 2. Long-running harness
const harness = createLongRunningHarness({
  harnessId: harnessId("autonomous-1"),
  agentId: agentId("autonomous-1"),
  harnessStore: snapshotStore,
  sessionPersistence,
  softCheckpointInterval: 5,
});

// 3. Auto-resume scheduler
const scheduler = createHarnessScheduler({
  harness,
  pollIntervalMs: 5000,
  maxRetries: 3,
});

// 4. Compose
const agent = createAutonomousAgent({ harness, scheduler });

// 5. Wire into engine
const piAdapter = createPiAdapter("anthropic:claude-sonnet-4-20250514");
const runtime = await createKoi({
  manifest: { name: "autonomous-agent", version: "1.0.0", tools: [] },
  adapter: createLoopAdapter({ adapter: piAdapter }),
  middleware: [...agent.middleware()],
});

// 6. Start autonomous operation
scheduler.start();
const startResult = await harness.start(taskPlan);
// Agent now runs autonomously — scheduler handles session boundaries

// 7. Graceful shutdown
await agent.dispose();
snapshotStore.close();
```

---

## API Reference

### Factory Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `createAutonomousAgent(parts)` | `AutonomousAgent` | Composes parts into coordinated agent |
| `createAgentFromBrick(brick, config)` | `Promise<Result<AgentInstantiateResult, KoiError>>` | Parse brick manifest + create adapter |
| `createSpawnFitnessWrapper(spawn, config)` | Wrapped spawn fn | Records spawn outcomes per brickId |
| `embedBrickId(manifest, brickId)` | `AgentManifest` | Immutably embeds brickId in manifest metadata |

### Agent Properties and Methods

| Property/Method | Type | Description |
|----------------|------|-------------|
| `harness` | `LongRunningHarness` | Direct reference to the harness |
| `scheduler` | `HarnessScheduler` | Direct reference to the scheduler |
| `middleware()` | `() → readonly KoiMiddleware[]` | Cached array: harness + checkpoint + inbox + compactor + memory + event-trace + report |
| `providers()` | `() → readonly ComponentProvider[]` | Plan autonomous + inbox providers |
| `dispose()` | `() → Promise<void>` | Idempotent: stop scheduler, then dispose harness |
| `agentResolver?` | `AgentResolver` | Auto-created from forgeStore if provided |
| `handoffBridge?` | `HarnessHandoffBridge` | Optional harness-to-handoff bridge |

### Types

| Type | Description |
|------|-------------|
| `AutonomousAgentParts` | Factory input — harness, scheduler, forgeStore, etc. |
| `AutonomousAgent` | Composed output — harness, scheduler, middleware, providers, dispose |
| `SpawnHealthRecorder` | Interface for recording spawn success/failure |
| `SpawnFitnessWrapperConfig` | Config for spawn outcome tracking |
| `AgentInstantiateConfig` | Config for creating runtime from brick |
| `AgentInstantiateResult` | Parsed manifest + adapter + brickId |

### Re-exported from Dependencies

| Type | From | Description |
|------|------|-------------|
| `LongRunningHarness` | `@koi/long-running` | Multi-session lifecycle interface |
| `HarnessScheduler` | `@koi/harness-scheduler` | Auto-resume scheduler interface |
| `KoiMiddleware` | `@koi/core` | Middleware hook interface |
| `AgentResolver` | `@koi/core` | Dynamic agent discovery interface |
| `TaskableAgent` | `@koi/core` | Resolved agent with manifest + brickId |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Instance-based factory (accept pre-constructed parts) | Caller controls construction of each part — no config explosion in the factory |
| Scheduler disposes before harness | Prevents scheduler from calling `resume()` on a disposed harness |
| Idempotent dispose | Safe to call from multiple cleanup paths (error handlers, shutdown hooks) |
| Cached middleware array | Same reference every call — avoids re-creating harness middleware |
| Optional compactor (not required) | Not all agents need context compaction; keep the minimal path simple |
| Optional event-trace and report | Not all agents need tracing/reporting; wired the same way as compactor |
| Event-trace before report in list | Event-trace (priority 475) wraps early; report (priority 275) captures final picture. Engine sorts by priority anyway |
| Accept `KoiMiddleware`, not handles | Caller creates the handle and passes `.middleware` — keeps handle management outside the bundle, avoids importing L2 types into L3 |
| Auto-create resolver from forgeStore | Zero-config forge bridge — just pass `forgeStore` |
| TTL cache for brick search (5s default) | Avoid hammering forge on every resolve call |
| Re-select on every resolve (no selection cache) | Fresh fitness exploration each time |
| Manifest cache by brickId (permanent) | Manifests are immutable per brick version |
| Spawn fitness is opt-in (manual wrap) | Factory doesn't own spawn fn — caller wraps it |

---

## Disposal Sequence

```
agent.dispose()
  │
  ├── 1. scheduler.dispose()
  │       │
  │       ├── sets stopRequested = true
  │       └── awaits pollLoop() completion
  │           (scheduler will not call resume() again)
  │
  └── 2. harness.dispose()
          │
          ├── closes stores
          └── rejects further operations
```

If `dispose()` is called again, it returns immediately (idempotent guard).

---

## Forge → Delegation Bridge

When `forgeStore` is passed to `createAutonomousAgent`, the factory auto-creates
a `CatalogAgentResolver` that bridges the forge (agent bricks) with delegation
tools (`task-spawn`, `parallel-minions`). No static agent maps needed.

### What It Enables

**Without forge** — hardcode every agent type in a static map:

```typescript
const agents = new Map([
  ["researcher", { name: "researcher", manifest: researcherManifest, ... }],
  ["coder", { name: "coder", manifest: coderManifest, ... }],
]);
```

**With forge** — agents discovered, selected by fitness, and tracked automatically:

```typescript
const agent = createAutonomousAgent({ harness, scheduler, forgeStore });

// agent.agentResolver is auto-created — pass to delegation tools
const koi = await createKoi({
  manifest, adapter,
  middleware: agent.middleware(),
  providers: [
    ...agent.providers(),
    createTaskSpawnProvider({
      agentResolver: agent.agentResolver,
      spawn: mySpawnFn,
    }),
    createParallelMinionsProvider({
      agentResolver: agent.agentResolver,
      spawn: mySpawnFn,
    }),
  ],
});
```

### How It Works

```
  createAutonomousAgent({ forgeStore })
    │
    ├── Auto-creates CatalogAgentResolver
    │     │
    │     ├── resolve("researcher")
    │     │     1. ForgeStore.search({ kind:"agent", tags:["researcher"] })
    │     │     2. Select best brick by fitness (weighted random)
    │     │     3. Parse manifest YAML (cached by brickId)
    │     │     4. Return TaskableAgent { name, manifest, brickId }
    │     │
    │     └── list()
    │           Returns all active agent brick summaries
    │
    └── Exposes agent.agentResolver
          │
          ├── task-spawn tool calls resolver.resolve(type) on each delegation
          └── parallel-minions tool calls resolver.resolve(type) for each task
```

### Spawn Fitness Tracking (Optional)

Wrap your spawn function to record outcomes per brick. Higher-performing bricks
get selected more often over time:

```typescript
import { createSpawnFitnessWrapper, embedBrickId } from "@koi/autonomous";

const wrappedSpawn = createSpawnFitnessWrapper(rawSpawn, { healthRecorder });
// Success → recordSuccess(brickId, latencyMs)
// Failure → recordFailure(brickId, latencyMs, error)
```

### Agent Demand Detection

When agent resolution fails (`NOT_FOUND`), the forge-demand system detects the
gap and can signal the forge to create new agent bricks:

| Trigger | Fires When |
|---------|-----------|
| `agent_capability_gap` | No agent bricks match requested type |
| `agent_repeated_failure` | Brick error rate exceeds threshold |
| `agent_latency_degradation` | Brick p95 latency exceeds threshold |

### Agent Instantiation

`createAgentFromBrick()` converts a raw `BrickArtifact` into a runtime-ready
config (parsed manifest + adapter):

```typescript
import { createAgentFromBrick } from "@koi/autonomous";

const result = await createAgentFromBrick(brick, {
  adapterFactory: async (manifest) => createPiAdapter({ model: manifest.model.name }),
});
// result.value = { manifest, adapter, brickId, middleware, providers }
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────────┐
    KoiMiddleware, AgentResolver, TaskableAgent, ForgeTrigger      │
                                                                   │
L0u @koi/manifest, @koi/validation, @koi/variant-selection ─────│
    loadManifestFromString, computeBrickFitness, selectByFitness   │
                                                                   │
L2  @koi/long-running ──────────────────────────────────────────│
    LongRunningHarness, checkpoint/inbox middleware                 │
                                                                   │
L2  @koi/catalog ───────────────────────────────────────────────│
    CatalogAgentResolver (forge-backed discovery + selection)      │
                                                                   │
L2  @koi/harness-scheduler ─────────────────────────────────────│
    HarnessScheduler                                              │
                                                                   ▼
L3  @koi/autonomous <────────────────────────────────────────────┘
    imports from L0 + L0u + L2 (composition only)
    x never imports @koi/engine (L1)
    ~ package.json: {
        "@koi/core": "workspace:*",
        "@koi/catalog": "workspace:*",
        "@koi/long-running": "workspace:*",
        "@koi/harness-scheduler": "workspace:*",
        "@koi/handoff": "workspace:*",
        "@koi/manifest": "workspace:*"
      }
```
