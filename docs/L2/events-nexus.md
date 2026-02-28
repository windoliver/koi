# @koi/events-nexus — Nexus-Backed Event Backend

An L2 implementation of the `EventBackend` contract (L0) using a Nexus filesystem via JSON-RPC 2.0. Provides durable event persistence for multi-node deployments with per-event atomic writes, OCC via sequence checking, FIFO/TTL eviction, and dead letter queue. Swap in for `@koi/events-memory` or `@koi/events-sqlite` with zero code changes to consumers.

---

## Why It Exists

`@koi/events-memory` stores events in a JavaScript `Map`. `@koi/events-sqlite` stores events on disk. Both are single-node:

- **No multi-node sharing** — two Koi nodes can't see each other's agents
- **No distributed coordination** — CAS conflicts are local to one process
- **No centralized audit trail** — events scattered across nodes

`@koi/events-nexus` fixes all three:

```
                events-memory    events-sqlite    events-nexus
                ─────────────    ─────────────    ────────────
Storage:        JS Map (RAM)     SQLite (disk)    Nexus filesystem (network)
Durability:     None             WAL mode         Nexus-managed
Multi-node:     ✗                ✗                ✓ shared across nodes
Crash recovery: Impossible       Replay from DB   Replay from Nexus
Audit trail:    None             Local file       Centralized
Concurrency:    JS single-thread db.transaction() OCC via sequence check
```

---

## Architecture

### Layer position

```
L0   @koi/core              ─ EventBackend, EventEnvelope, Result, KoiError
L0u  @koi/event-delivery    ─ createDeliveryManager (shared subscription chain)
L0u  @koi/hash              ─ generateUlid (event IDs)
L2   @koi/events-nexus      ─ this package
```

Imports from L0 + L0u only. Never touches `@koi/engine` (L1) or any peer L2 package.

### Internal module map

```
index.ts                    ← public re-exports
│
├── nexus-rpc.ts            ← JSON-RPC 2.0 client for Nexus filesystem API
├── paths.ts                ← path builders for streams, events, meta, DLQ
├── nexus-backend.ts        ← factory + EventBackend implementation
├── nexus-backend.test.ts   ← unit tests (contract + eviction + network errors)
├── fake-nexus-fetch.ts     ← in-memory fake Nexus server for testing
└── __tests__/
    └── e2e-full-stack.test.ts  ← full-stack E2E with real Anthropic API
```

### Nexus filesystem layout

Events are stored as individual JSON files. Each stream has a `meta.json` for O(1) sequence lookup and a directory of numbered event files.

```
/events/
├── streams/
│   ├── agent:kai/
│   │   ├── meta.json                  {"maxSequence": 3, "eventCount": 3}
│   │   └── events/
│   │       ├── 0000000001.json        agent_registered
│   │       ├── 0000000002.json        agent_transitioned (running)
│   │       └── 0000000003.json        agent_transitioned (terminated)
│   │
│   └── agent:mia/
│       ├── meta.json
│       └── events/
│           └── ...
│
├── subscriptions/
│   └── dashboard.json                 {"position": 42}
│
└── dlq/
    └── 01ARZ3NDEKTSV4RRFFQ69G5FAV.json
```

---

## Data Flow

### Append (atomic write)

```
caller                  NexusEventBackend                     Nexus FS
  │                            │                                │
  │  append("agent:kai",      │                                │
  │    { type, data })        │                                │
  │ ──────────────────────────>│                                │
  │                            │  read(meta.json)               │
  │                            │ ──────────────────────────────>│
  │                            │                 maxSeq = 2     │
  │                            │ <──────────────────────────────│
  │                            │                                │
  │                    ┌───────┴────────┐                       │
  │                    │ CAS check:     │                       │
  │                    │ expectedSeq == │                       │
  │                    │ current?       │                       │
  │                    └───────┬────────┘                       │
  │                            │                                │
  │                            │  write(events/0000000003.json) │
  │                            │ ──────────────────────────────>│
  │                            │                                │
  │                            │  write(meta.json)              │
  │                            │  {maxSeq: 3, count: 3}        │
  │                            │ ──────────────────────────────>│
  │                            │                                │
  │                            │  evictIfNeeded()               │
  │                            │  ─── delete excess files ─────>│
  │                            │                                │
  │                            │  notifySubscribers()           │
  │                            │                                │
  │  Result<EventEnvelope>     │                                │
  │ <──────────────────────────│                                │
```

### Multi-Node Sharing

```
  Node A                              Node B
  ┌─────────────────┐                ┌─────────────────┐
  │ append(agent:kai,│                │ read(agent:kai)  │
  │  {registered})   │                │                  │
  └────────┬────────┘                └────────┬────────┘
           │                                   │
           │    JSON-RPC 2.0 over HTTP         │
           ▼                                   ▼
  ┌────────────────────────────────────────────────────┐
  │                 Nexus Filesystem                    │
  │                                                    │
  │  /events/streams/agent:kai/meta.json               │
  │  /events/streams/agent:kai/events/0000000001.json  │
  │                                                    │
  │  Both nodes see the same events.                   │
  │  CAS via expectedSequence prevents conflicts.      │
  └────────────────────────────────────────────────────┘
```

### Crash Recovery

```
  Session 1 (before crash)              Session 2 (after restart)
  ────────────────────────              ─────────────────────────

  append(events) ──► Nexus FS           connect to same Nexus
  subscribe()                           │
  transition()                          ▼
                                   createEventSourcedRegistry(backend)
       ╔═══════════╗                    │
       ║  CRASH    ║                    │ rebuild() reads all streams
       ╚═══════════╝                    │ folds events → projection
                                        │
                                        ▼
                                   registry state = pre-crash state ✓
                                   events intact on Nexus ✓
                                   any node can rebuild ✓
```

---

## What This Enables for Agents

### Today: durable distributed lifecycle

```
CAN YOU ANSWER...                        WITH NEXUS BACKEND
──────────────────────────────────────   ──────────────────
"Is agent kai alive?"                    ✓ registry rebuilt from Nexus
"Why did kai terminate?"                 ✓ transition reason in events
"How many agents are running cluster-wide?" ✓ shared registry
"Did two nodes conflict on kai's state?"  ✓ CAS conflict detected
"Rebuild state after node crash?"        ✓ replay from Nexus
```

### Future: foundation for full observability

`events-nexus` is the storage primitive. Thin L2 sinks on top complete the picture:

```
events-nexus (this package)
    │
    ├──▶ registry-event-sourced   agent lifecycle         (done ✓)
    ├──▶ audit-sink-nexus         LLM/tool call logs      (#305)
    ├──▶ report-store-nexus       cost/token metrics       (future)
    └──▶ trace-store-nexus        rewind/replay            (future)
                │
                ▼
         @koi/observability (L3)    pre-wired bundle       (#483)
```

Each future sink is ~50 LOC — just `backend.append(streamId, entry)`. The hard problem (durable, distributed, concurrent-safe event storage with OCC) is solved here.

---

## Eviction

Two eviction strategies run after every append:

### FIFO eviction (`maxEventsPerStream`)

```
maxEventsPerStream = 5

  After append #5:  [1] [2] [3] [4] [5]         ← at cap
  After append #6:      [2] [3] [4] [5] [6]     ← evicted [1]
  After append #7:          [3] [4] [5] [6] [7]  ← evicted [2]
```

Implemented by deleting the oldest event file and updating `meta.json`.

### TTL eviction (`eventTtlMs`)

```
eventTtlMs = 3600000 (1 hour)

  Events:  [t-2h] [t-1.5h] [t-30m] [t-5m] [t-now]
  After:                    [t-30m] [t-5m] [t-now]
           ^^^^^^^^^^^^^^^^
           expired (older than 1h)
```

Both strategies compose: TTL runs first, then FIFO caps the remainder.

---

## API Reference

### Factory

#### `createNexusEventBackend(config)`

Creates a Nexus-backed `EventBackend`.

```typescript
import { createNexusEventBackend } from "@koi/events-nexus";
```

**Config:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `baseUrl` | `string` | required | Nexus server URL (e.g., `"http://localhost:2026"`) |
| `apiKey` | `string` | required | Nexus API key for authentication |
| `basePath` | `string` | `"/events"` | Storage path prefix on Nexus filesystem |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Injectable fetch for testing |
| `maxEventsPerStream` | `number` | `10_000` | FIFO eviction cap per stream |
| `eventTtlMs` | `number` | — | TTL in ms. Events older than this are excluded from reads |

### EventBackend methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `append` | `(streamId, event) → Result<EventEnvelope, KoiError>` | Atomic CAS + write + evict |
| `read` | `(streamId, options?) → Result<ReadResult, KoiError>` | Forward/backward, type filter, pagination |
| `subscribe` | `(options) → SubscriptionHandle` | Replay + live delivery |
| `queryDeadLetters` | `(filter?) → Result<readonly DeadLetterEntry[], KoiError>` | In-memory DLQ |
| `retryDeadLetter` | `(entryId) → Result<boolean, KoiError>` | Re-delivers via subscription chain |
| `purgeDeadLetters` | `(filter?) → Result<void, KoiError>` | Purges DLQ + Nexus DLQ files |
| `streamLength` | `(streamId) → number` | Respects TTL exclusion |
| `firstSequence` | `(streamId) → number` | Respects TTL exclusion |
| `close` | `() → void` | Closes all subscriptions |

---

## Examples

### 1. Basic usage (with fake Nexus for tests)

```typescript
import { createNexusEventBackend } from "@koi/events-nexus";
import { createFakeNexusFetch } from "@koi/events-nexus/fake-nexus-fetch";

const backend = createNexusEventBackend({
  baseUrl: "http://fake:2026",
  apiKey: "test-key",
  fetch: createFakeNexusFetch(),
});

// Append
const result = await backend.append("orders", {
  type: "order_placed",
  data: { orderId: "abc-123", total: 99.99 },
});
if (result.ok) {
  console.log(result.value.sequence); // 1
  console.log(result.value.id);       // ULID
}

// Read
const stream = await backend.read("orders");
if (stream.ok) {
  console.log(stream.value.events.length); // 1
}

backend.close();
```

### 2. Production multi-node deployment

```typescript
import { createNexusEventBackend } from "@koi/events-nexus";

const backend = createNexusEventBackend({
  baseUrl: process.env.NEXUS_URL!,
  apiKey: process.env.NEXUS_API_KEY!,
  maxEventsPerStream: 50_000,
  eventTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
});

// Multiple Koi nodes share the same Nexus → same events
// Node A writes, Node B reads — instant visibility
```

### 3. With event-sourced registry (full stack)

```typescript
import { createNexusEventBackend } from "@koi/events-nexus";
import { createEventSourcedRegistry } from "@koi/registry-event-sourced";
import { agentId } from "@koi/core";

const backend = createNexusEventBackend({
  baseUrl: "http://nexus.internal:2026",
  apiKey: process.env.NEXUS_API_KEY!,
});
const registry = await createEventSourcedRegistry(backend);

await registry.register({
  agentId: agentId("worker-1"),
  agentType: "worker",
  metadata: {},
  registeredAt: Date.now(),
  status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: 0 },
});

await registry.transition(agentId("worker-1"), "running", 0, {
  kind: "assembly_complete",
});

// Any other node connecting to the same Nexus can see worker-1
// If this node crashes, another node rebuilds state from Nexus
```

### 4. CAS conflict detection

```typescript
// Two concurrent writers — only one wins
const [r1, r2] = await Promise.all([
  backend.append("orders", {
    type: "update",
    data: { status: "shipped" },
    expectedSequence: 5,
  }),
  backend.append("orders", {
    type: "update",
    data: { status: "cancelled" },
    expectedSequence: 5,
  }),
]);

// Exactly one succeeds, one gets CONFLICT error
const winner = [r1, r2].find((r) => r.ok);
const loser  = [r1, r2].find((r) => !r.ok);
// loser.error.code === "CONFLICT"
```

---

## Backend Pluggability

The `EventBackend` interface (L0) is the sole contract. Swap backends by changing one line:

```
┌───────────────────────────────────────────────────────────┐
│  Consumer code (registry, middleware, subscriptions)       │
│  Uses EventBackend — identical regardless of backend      │
└───────────────────────────────┬───────────────────────────┘
                                │
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
   ┌──────────────────┐ ┌──────────────┐ ┌──────────────────┐
   │ @koi/events-memory│ │ events-sqlite│ │  events-nexus    │
   │ In-memory (tests) │ │ Single-node  │ │  Multi-node      │
   │ ✅ Available       │ │ ✅ Available  │ │  ✅ Available     │
   └──────────────────┘ └──────────────┘ └──────────────────┘
```

---

## Testing

### Unit tests (39 tests)

```bash
bun test packages/events-nexus/src/nexus-backend.test.ts
```

Three describe blocks:

| Block | Backend | Tests |
|-------|---------|-------|
| Contract tests | Fake Nexus | All `EventBackend` contract tests via `runEventBackendContractTests()` |
| Nexus-specific | Fake Nexus | FIFO eviction, TTL eviction, OCC, `meta.json` management |
| Error handling | Fake Nexus | Network errors, malformed responses, method-not-found |

### E2E tests (7 tests, real Anthropic API)

```bash
E2E_TESTS=1 bun test packages/events-nexus/src/__tests__/e2e-full-stack.test.ts
```

| # | Test | What it proves |
|---|------|----------------|
| 1 | Text response through full runtime | nexus backend + registry + createKoi + Pi adapter + real LLM |
| 2 | Tool call through middleware chain | tool via ComponentProvider + wrapToolCall middleware observes |
| 3 | Registry watch fires during lifecycle | `watch()` delivers registered/transitioned events |
| 4 | Rebuild from persisted nexus events | fresh registry from same backend reconstructs state |
| 5 | Multi-agent concurrent lifecycle | 2 agents sharing nexus backend, independent streams |
| 6 | Middleware lifecycle hooks | `onSessionStart`, `onSessionEnd`, `onAfterTurn` fire |
| 7 | CAS conflict on concurrent transitions | two `transition()` at same generation — one wins, one CONFLICT |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    EventBackend, EventEnvelope, KoiError, Result            │
                                                             │
L0u @koi/event-delivery ── createDeliveryManager ───────────┤
L0u @koi/hash ──────────── generateUlid ────────────────────┤
                                                             ▼
L2  @koi/events-nexus ◄────────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```

**Dev-only dependencies** (`@koi/engine`, `@koi/engine-pi`, `@koi/registry-event-sourced`, `@koi/test-utils`) are used in E2E tests but are not runtime imports.
