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
createAutonomousAgent({ harness, scheduler, compactorMiddleware? })
  │
  ├── cache middleware: [harness.createMiddleware(), compactorMiddleware?]
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
}
```

There is no separate config type. Callers construct each part with their own configuration, then pass them in.

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

### Agent Properties and Methods

| Property/Method | Type | Description |
|----------------|------|-------------|
| `harness` | `LongRunningHarness` | Direct reference to the harness |
| `scheduler` | `HarnessScheduler` | Direct reference to the scheduler |
| `middleware()` | `() → readonly KoiMiddleware[]` | Cached array: harness MW + optional compactor |
| `dispose()` | `() → Promise<void>` | Idempotent: stop scheduler, then dispose harness |

### Types

| Type | Description |
|------|-------------|
| `AutonomousAgentParts` | `{ harness, scheduler, compactorMiddleware? }` — factory input |
| `AutonomousAgent` | `{ harness, scheduler, middleware, dispose }` — composed output |

### Re-exported from Dependencies

| Type | From | Description |
|------|------|-------------|
| `LongRunningHarness` | `@koi/long-running` | Multi-session lifecycle interface |
| `HarnessScheduler` | `@koi/harness-scheduler` | Auto-resume scheduler interface |
| `KoiMiddleware` | `@koi/core` | Middleware hook interface |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Instance-based factory (accept pre-constructed parts) | Caller controls construction of each part — no config explosion in the factory |
| Scheduler disposes before harness | Prevents scheduler from calling `resume()` on a disposed harness |
| Idempotent dispose | Safe to call from multiple cleanup paths (error handlers, shutdown hooks) |
| Cached middleware array | Same reference every call — avoids re-creating harness middleware |
| Optional compactor (not required) | Not all agents need context compaction; keep the minimal path simple |
| No new logic (pure composition) | L3 meta-packages must not add behavior — only wire existing parts |

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

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────────┐
    KoiMiddleware                                                  │
                                                                   │
L2  @koi/long-running ──────────────────────────────────────────│
    LongRunningHarness                                            │
                                                                   │
L2  @koi/harness-scheduler ─────────────────────────────────────│
    HarnessScheduler                                              │
                                                                   ▼
L3  @koi/autonomous <────────────────────────────────────────────┘
    imports from L0 + L2 (composition only)
    x never imports @koi/engine (L1)
    x adds zero new logic — pure wiring
    ~ package.json: {
        "@koi/core": "workspace:*",
        "@koi/long-running": "workspace:*",
        "@koi/harness-scheduler": "workspace:*"
      }
```
