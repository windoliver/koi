# @koi/scheduler-nexus — Nexus-Backed Distributed Scheduler

Implements L0 `TaskStore`, `ScheduleStore`, and `TaskQueueBackend` contracts using Nexus as the distributed backend. Enables cross-node task scheduling with at-least-once delivery, atomic claim semantics, and cron tick deduplication.

**Layer:** L2 (depends on `@koi/core`, `@koi/nexus-client`, `@koi/errors`, `@koi/resolve`)

---

## Why It Exists

In a single-node Koi deployment, the scheduler uses local SQLite for persistence and an in-memory min-heap for priority ordering. This works well for one process but breaks down when agents run across multiple nodes:

1. **Crashed tasks are stuck** — if Node A dies mid-task, no other node can see or retry it
2. **Duplicate cron execution** — every node fires every cron independently, causing N-times execution
3. **No work distribution** — tasks can only run on the node that created them
4. **No shared queue** — priority ordering is per-node, not global

`@koi/scheduler-nexus` solves all of these by delegating task storage, schedule persistence, and claim arbitration to a shared Nexus server.

---

## What This Enables

### Single-Node (Before — SQLite Only)

```
┌──────────────────────────────────────────┐
│  Node A (only node)                       │
│                                           │
│  ┌──────────┐    ┌───────────────────┐   │
│  │  Cron    │───▶│  Local SQLite     │   │
│  │  Timer   │    │  + Min-Heap       │   │
│  └──────────┘    └────────┬──────────┘   │
│  ┌──────────┐             │ poll()       │
│  │ submit() │───▶         ▼              │
│  └──────────┘    ┌───────────────────┐   │
│                  │  Local Dispatch   │   │
│                  └───────────────────┘   │
└──────────────────────────────────────────┘

If Node A crashes → tasks are stuck, cron stops firing
```

### Multi-Node (After — Nexus-Backed)

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  Node A  │     │  Node B  │     │  Node C  │
│          │     │          │     │          │
│  claim() │     │  claim() │     │  claim() │
│  ack()   │     │  ack()   │     │  ack()   │
│  tick()  │     │  tick()  │     │  tick()  │
└─────┬────┘     └─────┬────┘     └─────┬────┘
      │                │                │
      └───────────┬────┴────────────────┘
                  ▼
         ┌──────────────────┐
         │  Nexus Server    │
         │                  │
         │  Task Store      │ ← persistent, shared
         │  Schedules       │ ← cron definitions
         │  Tick Claims     │ ← dedup per window
         │  Claim Queue     │ ← visibility timeout
         └──────────────────┘
```

**Key behaviors:**

- **At-least-once delivery** — if a node crashes mid-task, the visibility timeout expires and another node re-claims it
- **No duplicate cron execution** — `tick()` uses minute-level bucketing; first node to tick wins, others skip
- **Adaptive polling** — empty claims trigger exponential backoff to reduce Nexus load; resets instantly when tasks appear
- **Auto-detection** — scheduler detects distributed mode when `queueBackend.claim` is present; falls back to local mode otherwise

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  @koi/scheduler-nexus  (L2)                                      │
│                                                                   │
│  nexus-task-store.ts       ← createNexusTaskStore()              │
│  nexus-schedule-store.ts   ← createNexusScheduleStore()          │
│  nexus-queue.ts            ← createNexusTaskQueue()              │
│  nexus-scheduler.ts        ← createNexusSchedulerBackends()      │
│  scheduler-config.ts       ← NexusSchedulerConfig + validator    │
│  config.ts                 ← NexusTaskQueueConfig (base)         │
│  index.ts                  ← public API surface                   │
│                                                                   │
├─────────────────────────────────────────────────────────────────  │
│  Dependencies                                                     │
│                                                                   │
│  @koi/core          (L0)   TaskStore, ScheduleStore,              │
│                             TaskQueueBackend, ScheduledTask,       │
│                             CronSchedule, branded IDs              │
│  @koi/nexus-client  (L0u)  NexusClient, mapHttpError              │
│  @koi/errors        (L0u)  isKoiError                              │
│  @koi/resolve       (L0u)  BrickDescriptor                         │
└─────────────────────────────────────────────────────────────────  ┘
```

---

## How It Works

### Transport

Two transport layers coexist for backwards compatibility:

| Operation | Transport | Why |
|-----------|-----------|-----|
| `enqueue`, `cancel`, `status` | REST (HTTP) | Existing API, backwards-compatible |
| `claim`, `ack`, `nack`, `tick` | JSON-RPC (NexusClient) | New distributed methods, batch-friendly |
| `TaskStore.*`, `ScheduleStore.*` | JSON-RPC (NexusClient) | Full CRUD, consistent with other Nexus stores |

### RPC Method Mapping

**TaskStore:**

| Method | JSON-RPC | Params |
|--------|----------|--------|
| `save(task)` | `scheduler.task.save` | Full task (snake_case) |
| `load(id)` | `scheduler.task.load` | `{ id }` |
| `remove(id)` | `scheduler.task.remove` | `{ id }` |
| `updateStatus(id, status, patch?)` | `scheduler.task.updateStatus` | `{ id, status, started_at?, ... }` |
| `query(filter)` | `scheduler.task.query` | `{ status?, agent_id?, priority?, limit? }` |
| `loadPending()` | `scheduler.task.query` | `{ status: "pending" }` |

**ScheduleStore:**

| Method | JSON-RPC | Params |
|--------|----------|--------|
| `saveSchedule(schedule)` | `scheduler.schedule.save` | Full schedule (snake_case) |
| `removeSchedule(id)` | `scheduler.schedule.remove` | `{ id }` |
| `loadSchedules()` | `scheduler.schedule.list` | `{}` |

**Distributed queue (optional methods on TaskQueueBackend):**

| Method | JSON-RPC | Params | Response |
|--------|----------|--------|----------|
| `claim(nodeId, limit?)` | `scheduler.claim` | `{ node_id, limit?, visibility_timeout_ms }` | Full tasks |
| `ack(taskId, result?)` | `scheduler.ack` | `{ task_id, result? }` | `{ ok }` |
| `nack(taskId, reason?)` | `scheduler.nack` | `{ task_id, reason? }` | `{ ok }` |
| `tick(scheduleId, nodeId)` | `scheduler.tick` | `{ schedule_id, node_id }` | `{ claimed }` |

### Claim Flow

```
  Node A                         Nexus Server
  ┌──────────┐                  ┌──────────────────────┐
  │ claim(   │                  │                      │
  │  "a",    │  ──── RPC ────→  │ 1. Find pending tasks │
  │  limit=3 │                  │ 2. Mark claimed_by=a  │
  │ )        │                  │ 3. Set claimed_at=now │
  │          │ ◄── tasks[] ──── │ 4. Return full tasks  │
  │          │                  │                      │
  │ execute  │                  │  If no ack within     │
  │ ...      │                  │  visibilityTimeoutMs: │
  │          │                  │  → task becomes       │
  │ ack(id)  │  ──── RPC ────→  │    claimable again    │
  │          │ ◄── { ok } ───── │ 5. Mark completed     │
  └──────────┘                  └──────────────────────┘
```

### Cron Tick Deduplication

```
All nodes evaluate cron expressions locally every minute.
When a schedule fires:

  Node A: tick("sched_1", "node-a") → { claimed: true }  ← winner, enqueues
  Node B: tick("sched_1", "node-b") → { claimed: false } ← skips
  Node C: tick("sched_1", "node-c") → { claimed: false } ← skips

Server uses minute-level bucketing: key = "${scheduleId}:${Math.floor(now/60000)}"
First caller wins. Subsequent calls in the same bucket return false.
```

### Ownership Split

```
┌─────────────────────────────────┬──────────────────────────────────┐
│         Koi Owns                │         Nexus Owns               │
├─────────────────────────────────┼──────────────────────────────────┤
│  Cron expression parsing        │  Task persistence (shared)       │
│  Cron fire timing               │  Schedule persistence (shared)   │
│  Retry count + backoff calc     │  Priority queue ordering         │
│  Dead-letter after max retries  │  Claim arbitration (vis timeout) │
│  Task timeout enforcement       │  Tick deduplication              │
│  Schedule pause/resume          │  Cross-node task visibility      │
│  Event emission (watch)         │  Idempotency deduplication       │
│  Adaptive poll backoff          │  Fair-share admission control    │
└─────────────────────────────────┴──────────────────────────────────┘
```

---

## Configuration

### `NexusSchedulerConfig` (recommended)

```typescript
interface NexusSchedulerConfig {
  readonly baseUrl: string;               // Nexus server URL
  readonly apiKey: string;                 // Bearer token
  readonly timeoutMs?: number;             // HTTP timeout (default: 10,000ms)
  readonly visibilityTimeoutMs?: number;   // Claim expiry (default: 30,000ms)
  readonly fetch?: typeof globalThis.fetch; // Injectable for testing
}
```

| Config | Default | Description |
|--------|---------|-------------|
| `baseUrl` | (required) | Nexus server URL |
| `apiKey` | (required) | Bearer token for authentication |
| `timeoutMs` | `10_000` | HTTP request timeout |
| `visibilityTimeoutMs` | `30_000` | How long a claimed task stays invisible to other nodes |
| `fetch` | `globalThis.fetch` | Injectable fetch for testing with fakes |

### `NexusTaskQueueConfig` (base — REST-only queue)

Subset of `NexusSchedulerConfig` without `visibilityTimeoutMs`. Use when you only need `enqueue`/`cancel`/`status` without distributed claim semantics.

### Error Mapping

| HTTP Status | KoiError Code | Retryable |
|-------------|---------------|-----------|
| 401, 403 | `PERMISSION` | No |
| 404 | `NOT_FOUND` | No |
| 429 | `RATE_LIMIT` | Yes |
| 500+ | `EXTERNAL` | Yes |
| Network failure | `EXTERNAL` | Yes |

---

## Examples

### Full Distributed Setup (Recommended)

```typescript
import { createNexusSchedulerBackends } from "@koi/scheduler-nexus";
import { createScheduler } from "@koi/scheduler";

// One config → all three backends
const { taskStore, scheduleStore, queueBackend } = createNexusSchedulerBackends({
  baseUrl: "https://nexus.example.com",
  apiKey: process.env.NEXUS_API_KEY,
  visibilityTimeoutMs: 30_000,
});

// Scheduler auto-detects distributed mode
const scheduler = createScheduler(
  config,
  taskStore,
  dispatcher,
  undefined,        // clock
  scheduleStore,
  queueBackend,
  "node-east-1",    // nodeId — identifies this node
);

// Submit — any node in the cluster can pick it up
await scheduler.submit({ agentId: "my-agent", input: { text: "hello" } });

// Cron — all nodes evaluate, only one enqueues per tick window
await scheduler.schedule({
  expression: "*/5 * * * *",
  agentId: "cleanup-agent",
  input: { kind: "cleanup" },
});
```

### REST-Only Queue (No Distributed Claims)

```typescript
import { createNexusTaskQueue } from "@koi/scheduler-nexus";

const backend = createNexusTaskQueue({
  baseUrl: "https://astraea.nexus.example.com",
  apiKey: process.env.NEXUS_API_KEY,
});

// Only enqueue/cancel/status — no claim/ack/nack/tick
const scheduler = createScheduler(config, store, dispatcher, clock, scheduleStore, backend);
```

### Individual Backends

```typescript
import { createNexusClient } from "@koi/nexus-client";
import { createNexusTaskStore, createNexusScheduleStore } from "@koi/scheduler-nexus";

const client = createNexusClient({ baseUrl, apiKey });
const taskStore = createNexusTaskStore(client);
const scheduleStore = createNexusScheduleStore(client);
```

### Testing with Fake Nexus

```typescript
import { createNexusSchedulerBackends } from "@koi/scheduler-nexus";
import { createFakeNexusFetch } from "@koi/test-utils";

const { taskStore, scheduleStore, queueBackend } = createNexusSchedulerBackends({
  baseUrl: "http://fake-nexus",
  apiKey: "test-key",
  fetch: createFakeNexusFetch(),  // in-memory JSON-RPC server
});
```

---

## API Reference

### Factories

| Function | Returns | Description |
|----------|---------|-------------|
| `createNexusSchedulerBackends(config)` | `NexusSchedulerBackends` | Creates all three backends from one config |
| `createNexusTaskStore(client)` | `TaskStore` | Nexus-backed task persistence |
| `createNexusScheduleStore(client)` | `ScheduleStore` | Nexus-backed schedule persistence |
| `createNexusTaskQueue(config)` | `TaskQueueBackend` | Priority queue + distributed claim/ack/nack/tick |

### Validation

| Function | Returns | Description |
|----------|---------|-------------|
| `validateNexusSchedulerConfig(raw)` | `Result<NexusSchedulerConfig, KoiError>` | Validates full distributed config |
| `validateNexusTaskQueueConfig(raw)` | `Result<NexusTaskQueueConfig, KoiError>` | Validates base queue config |

### Types

| Type | Description |
|------|-------------|
| `NexusSchedulerConfig` | Full config with `visibilityTimeoutMs` |
| `NexusTaskQueueConfig` | Base config (REST-only queue) |
| `NexusSchedulerBackends` | `{ taskStore, scheduleStore, queueBackend }` |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Two transports (REST + JSON-RPC) | Existing enqueue/cancel/status stays REST for backwards compat. New distributed methods use JSON-RPC for batch-friendly semantics. |
| Optional distributed methods on L0 | `claim`/`ack`/`nack`/`tick` are optional on `TaskQueueBackend`. Existing SQLite implementations are unaffected. |
| Visibility timeout (server-managed) | Server tracks claim time + timeout. No distributed locks or coordination protocols needed. |
| Minute-level tick bucketing | Cron expressions have minute granularity. Using 1-minute windows matches the minimum cron interval. |
| Shared NexusClient in composite factory | `createNexusSchedulerBackends` creates one client shared across all three backends. |
| Wire format uses snake_case | Matches Nexus API conventions. Mapper functions handle camelCase conversion. |
| Koi owns retry, Nexus is dumb queue | Retry policy is agent-specific; centralizing it in Nexus would leak Koi semantics. |
| Adaptive polling with backoff | Empty claim results trigger exponential backoff (via `computeRetryDelay`). Prevents thundering herd on idle clusters. |
| Contract test suites | `runTaskStoreContractTests` and `runScheduleStoreContractTests` verify both SQLite and Nexus stores with identical assertions. |

---

## Swappable Backends

`@koi/scheduler-nexus` provides distributed implementations of three L0 interfaces:

```
                    TaskStore                (L0 interface)
                       │
              ┌────────┴────────┐
              ▼                 ▼
          SQLite             Nexus
        (single-node)    (multi-node,
                          JSON-RPC)

                 ScheduleStore               (L0 interface)
                       │
              ┌────────┴────────┐
              ▼                 ▼
          SQLite             Nexus

              TaskQueueBackend               (L0 interface)
                       │
              ┌────────┴────────┐
              ▼                 ▼
         Local heap          Nexus
       (in-memory)     (REST + JSON-RPC,
                        claim/ack/nack)
```

---

## File Structure

```
packages/sched/scheduler-nexus/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                    # Public API exports
    ├── config.ts                   # NexusTaskQueueConfig (base)
    ├── scheduler-config.ts         # NexusSchedulerConfig + validator
    ├── nexus-queue.ts              # createNexusTaskQueue() — REST + JSON-RPC
    ├── nexus-task-store.ts         # createNexusTaskStore() — JSON-RPC
    ├── nexus-schedule-store.ts     # createNexusScheduleStore() — JSON-RPC
    ├── nexus-scheduler.ts          # createNexusSchedulerBackends() — composite
    ├── descriptor.ts               # BrickDescriptor for manifest resolution
    ├── config.test.ts              # Base config validation tests
    ├── scheduler-config.test.ts    # Full config validation tests
    ├── nexus-queue.test.ts         # HTTP client tests
    ├── nexus-task-store.test.ts    # Contract tests (via fake-nexus-fetch)
    ├── nexus-schedule-store.test.ts # Contract tests (via fake-nexus-fetch)
    └── nexus-distributed.test.ts   # 5 distributed scenario tests
```

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────────────┐
    TaskStore, ScheduleStore, TaskQueueBackend,                 │
    ScheduledTask, CronSchedule, TaskFilter,                    │
    TaskId, ScheduleId, AgentId, taskId(), scheduleId()         │
                                                                 │
L0u @koi/nexus-client ──────────────────────────────────────  │
    NexusClient, createNexusClient, mapHttpError                │
                                                                 │
L0u @koi/errors ────────────────────────────────────────────  │
    isKoiError                                                   │
                                                                 │
L0u @koi/resolve ───────────────────────────────────────────  │
    BrickDescriptor                                              │
                                                                 ▼
L2  @koi/scheduler-nexus ◄─────────────────────────────────  ┘
    imports from L0 and L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
    ✓ NexusClient injected, not created at module level
    ✓ RPC errors wrapped with cause chaining
```

---

## Related

- Issue: #756 — feat: Scheduler Nexus Backend (Distributed Job Queue)
- `@koi/scheduler` — Core scheduler with SQLite store, poll loop, cron engine
- `@koi/nexus-client` — Shared JSON-RPC transport
- `@koi/test-utils` — `createFakeNexusFetch()` with scheduler RPC handlers, contract test suites
- `@koi/store-nexus` — Same pattern for ForgeStore (brick storage)
- `@koi/filesystem-nexus` — Same pattern for FileSystemBackend
