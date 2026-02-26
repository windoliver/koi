# @koi/events-sqlite — SQLite-Backed Event Backend

An L2 implementation of the `EventBackend` contract (L0) using `bun:sqlite`. Provides durable event persistence for single-node deployments with WAL mode, crash recovery via replay, FIFO/TTL eviction, dead letter queue, and full audit trail. Swap in for `@koi/events-memory` with zero code changes to consumers.

---

## Why It Exists

`@koi/events-memory` stores events in a JavaScript `Map`. Fast and simple, but:

- **No durability** — all events lost on process crash or restart
- **No audit trail** — cannot answer "what happened at 3am?"
- **No crash recovery** — registry, subscriptions, and DLQ are gone after restart

`@koi/events-sqlite` fixes all three:

```
                events-memory                events-sqlite
                ─────────────                ─────────────
Storage:        JS Map (RAM)                 SQLite file (disk)
Durability:     None                         WAL mode, fsync
Crash recovery: Impossible                   Replay from event log
Audit trail:    None                         Every event persisted
DLQ:            In-memory only               Persisted in dead_letters table
Eviction:       FIFO only                    FIFO + TTL
Concurrency:    Atomic via JS single-thread  Atomic via db.transaction()
```

---

## Architecture

### Layer position

```
L0   @koi/core              ─ EventBackend, EventEnvelope, Result, KoiError
L0u  @koi/sqlite-utils      ─ openDb, mapSqliteError, wrapSqlite
L0u  @koi/event-delivery    ─ createDeliveryManager (shared subscription chain)
L0u  @koi/hash              ─ generateUlid (event IDs)
L2   @koi/events-sqlite     ─ this package
```

Imports from L0 + L0u only. Never touches `@koi/engine` (L1) or any peer L2 package.

### Internal module map

```
index.ts                    ← public re-exports
│
├── schema.ts               ← DDL + PRAGMA user_version migrations (internal)
├── sqlite-backend.ts       ← factory + EventBackend implementation
├── sqlite-backend.test.ts  ← unit tests (contract + persistence + eviction)
└── __tests__/
    └── e2e.test.ts         ← full-stack E2E with real Anthropic API
```

### SQLite schema

Three tables, all `STRICT`. The `events` table uses `WITHOUT ROWID` — the composite PK is the B-tree key for clustered access by `(stream_id, sequence)`.

```sql
── events ─────────────────────────────── STRICT, WITHOUT ROWID ──
  stream_id  TEXT     NOT NULL  ─┐
  sequence   INTEGER  NOT NULL  ─┘ PRIMARY KEY (composite)
  id         TEXT     NOT NULL     UNIQUE INDEX
  type       TEXT     NOT NULL
  timestamp  INTEGER  NOT NULL
  data       TEXT     NOT NULL     (JSON)
  metadata   TEXT                  (JSON, nullable)

── subscriptions ───────────────────────────────────────
  subscription_name  TEXT  PRIMARY KEY
  stream_id          TEXT  NOT NULL
  position           INTEGER  NOT NULL  DEFAULT 0
  created_at         INTEGER  NOT NULL

── dead_letters ────────────────────────────────────────
  id                 TEXT  PRIMARY KEY
  subscription_name  TEXT  NOT NULL     INDEX
  event_data         TEXT  NOT NULL     (denormalized JSON)
  error_message      TEXT  NOT NULL
  attempts           INTEGER  NOT NULL
  dead_lettered_at   INTEGER  NOT NULL
```

---

## Data Flow

### Append (atomic transaction)

```
caller                  SqliteEventBackend                    SQLite
  │                            │                                │
  │  append("stream-1",       │                                │
  │    { type, data })        │                                │
  │ ──────────────────────────>│                                │
  │                            │  BEGIN TRANSACTION             │
  │                            │ ──────────────────────────────>│
  │                            │                                │
  │                            │  SELECT MAX(sequence)          │
  │                            │  FROM events                   │
  │                            │  WHERE stream_id = "stream-1"  │
  │                            │ ──────────────────────────────>│
  │                            │                  max_seq = 2   │
  │                            │ <──────────────────────────────│
  │                            │                                │
  │                    ┌───────┴────────┐                       │
  │                    │ CAS check:     │                       │
  │                    │ expectedSeq == │                       │
  │                    │ current?       │                       │
  │                    └───────┬────────┘                       │
  │                            │                                │
  │                            │  INSERT INTO events            │
  │                            │  (stream_id, 3, ulid, ...)     │
  │                            │ ──────────────────────────────>│
  │                            │                                │
  │                            │  evictIfNeeded("stream-1")     │
  │                            │  ─── DELETE excess rows ──────>│
  │                            │                                │
  │                            │  COMMIT                        │
  │                            │ ──────────────────────────────>│
  │                            │                                │
  │                            │  notifySubscribers()           │
  │                            │                                │
  │  Result<EventEnvelope>     │                                │
  │ <──────────────────────────│                                │
```

### Subscribe + Replay

```
caller                  SqliteEventBackend         event-delivery        SQLite
  │                            │                        │                  │
  │  subscribe({               │                        │                  │
  │    streamId, fromPos: 0 }) │                        │                  │
  │ ──────────────────────────>│                        │                  │
  │                            │  dm.subscribe()        │                  │
  │                            │ ──────────────────────>│                  │
  │                            │                        │                  │
  │                            │                        │  readStream()    │
  │                            │                        │ ────────────────>│
  │                            │                        │  ← events[1..N] │
  │                            │                        │ <────────────────│
  │                            │                        │                  │
  │                            │                        │  deliver(evt-1)  │
  │  handler(evt-1) ◄──────────┼────────────────────────│  deliver(evt-2)  │
  │  handler(evt-2) ◄──────────┼────────────────────────│  ...             │
  │                            │                        │                  │
  │                            │                        │  persistPosition │
  │                            │                        │ ────────────────>│
  │                            │                        │  UPSERT sub pos  │
  │                            │                        │                  │
  │  SubscriptionHandle        │                        │                  │
  │ <──────────────────────────│                        │                  │
```

### Crash Recovery

```
  Session 1 (before crash)              Session 2 (after restart)
  ────────────────────────              ─────────────────────────

  append(events) ──► SQLite             reopen SQLite
  subscribe()                           │
  transition()                          ▼
                                   createEventSourcedRegistry(backend)
                                        (from @koi/registry-event-sourced — optional consumer)
       ╔═══════════╗                    │
       ║  CRASH    ║                    │ rebuild() reads all streams
       ╚═══════════╝                    │ folds events → projection
                                        │
                                        ▼
                                   registry state = pre-crash state ✓
                                   events intact ✓
                                   DLQ entries intact ✓
                                   audit trail intact ✓
```

---

## Eviction

Two eviction strategies run after every append:

### FIFO eviction (`maxEventsPerStream`)

```
maxEventsPerStream = 5

  Eviction runs after every append:

  After append #5:  [1] [2] [3] [4] [5]   ← at cap
  After append #6:      [2] [3] [4] [5] [6]   ← evicted [1]
  After append #7:          [3] [4] [5] [6] [7]   ← evicted [2]
  After append #8:              [4] [5] [6] [7] [8]   ← evicted [3]
```

Implemented as a single DELETE with correlated subquery — no scanning.

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

#### `createSqliteEventBackend(config?)`

Creates a SQLite-backed `EventBackend`. Accepts either a file path (creates and owns the Database lifecycle) or an injected Database instance (caller owns lifecycle).

```typescript
import { createSqliteEventBackend } from "@koi/events-sqlite";
```

**Config:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dbPath` | `string` | `":memory:"` | SQLite file path. Creates the DB. |
| `db` | `Database` | — | Injected `bun:sqlite` Database. Caller owns lifecycle. |
| `maxEventsPerStream` | `number` | `10_000` | FIFO eviction cap per stream. |
| `eventTtlMs` | `number` | — | TTL in ms. Events older than this are excluded from reads. |

Provide either `dbPath` or `db`, not both.

### EventBackend methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `append` | `(streamId, event) → Result<EventEnvelope, KoiError>` | Atomic CAS + insert + evict |
| `read` | `(streamId, options?) → Result<ReadResult, KoiError>` | Forward/backward, type filter, pagination |
| `subscribe` | `(options) → SubscriptionHandle` | Replay + live delivery |
| `queryDeadLetters` | `(filter?) → Result<readonly DeadLetterEntry[], KoiError>` | Merges SQLite + in-memory DLQ |
| `retryDeadLetter` | `(entryId) → Result<boolean, KoiError>` | Re-delivers via subscription chain |
| `purgeDeadLetters` | `(filter?) → Result<void, KoiError>` | Purges from both SQLite and memory |
| `streamLength` | `(streamId) → number` | Respects TTL exclusion |
| `firstSequence` | `(streamId) → number` | Respects TTL exclusion |
| `close` | `() → void` | Closes subscriptions, runs PRAGMA optimize, closes DB if owned |

### ReadOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fromSequence` | `number` | `1` | Start reading from this sequence (inclusive) |
| `toSequence` | `number` | unbounded | Stop reading at this sequence (exclusive) |
| `direction` | `"forward" \| "backward"` | `"forward"` | Read direction |
| `limit` | `number` | unbounded | Max events to return |
| `types` | `string[]` | — | Filter by event type |

### SubscribeOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `streamId` | `string` | required | Stream to subscribe to |
| `subscriptionName` | `string` | required | Durable name — position tracked by this name |
| `fromPosition` | `number` | latest | Replay from this sequence; `0` = replay all |
| `handler` | `(event: EventEnvelope) => void \| Promise<void>` | required | Called per event; throw to trigger retry |
| `maxRetries` | `number` | `3` | Max delivery attempts before dead-lettering |
| `types` | `string[]` | — | Only deliver events matching these types |
| `onDeadLetter` | `(entry: DeadLetterEntry) => void` | — | Callback when an event is dead-lettered |

---

## Examples

### 1. Basic usage (in-memory for tests)

```typescript
import { Database } from "bun:sqlite";
import { createSqliteEventBackend } from "@koi/events-sqlite";

const backend = createSqliteEventBackend({ db: new Database(":memory:") });

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
```

### 2. File-backed persistence

```typescript
import { createSqliteEventBackend } from "@koi/events-sqlite";

// Creates and owns the SQLite database
const backend = createSqliteEventBackend({ dbPath: "./data/events.db" });

await backend.append("stream-1", { type: "evt", data: { x: 1 } });
backend.close(); // flushes WAL, closes DB

// Reopen later — events are still there
const backend2 = createSqliteEventBackend({ dbPath: "./data/events.db" });
const result = await backend2.read("stream-1");
// result.value.events[0].data → { x: 1 }
```

### 3. With event-sourced registry (full stack)

```typescript
import { createSqliteEventBackend } from "@koi/events-sqlite";
import { createEventSourcedRegistry } from "@koi/registry-event-sourced";
import { agentId } from "@koi/core";
import { join } from "node:path";
import { homedir } from "node:os";

const backend = createSqliteEventBackend({
  dbPath: join(homedir(), ".koi", "events.db"),
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

// Crash and recover — state rebuilds from SQLite
backend.close();

const backend2 = createSqliteEventBackend({
  dbPath: join(homedir(), ".koi", "events.db"),
});
const recovered = await createEventSourcedRegistry(backend2);
const entry = recovered.lookup(agentId("worker-1"));
// entry.status.phase === "running" ✓
```

### 4. Subscriptions with replay

```typescript
const backend = createSqliteEventBackend({ dbPath: "./events.db" });

// Append some events
await backend.append("metrics", { type: "cpu", data: { pct: 45 } });
await backend.append("metrics", { type: "mem", data: { pct: 72 } });

// Subscribe from beginning — replays existing events, then delivers new ones
// L0 contract returns SubscriptionHandle | Promise<SubscriptionHandle>;
// SQLite impl is sync, but callers should always await for portability.
const received: EventEnvelope[] = [];
const handle = await backend.subscribe({
  streamId: "metrics",
  subscriptionName: "dashboard",
  fromPosition: 0,
  handler: (evt) => { received.push(evt); },
});

// received already has 2 events from replay

// New events delivered live
await backend.append("metrics", { type: "cpu", data: { pct: 51 } });
// received now has 3 events

handle.unsubscribe();
```

### 5. Eviction with FIFO + TTL

```typescript
const backend = createSqliteEventBackend({
  dbPath: "./events.db",
  maxEventsPerStream: 1000,   // keep last 1000 events per stream
  eventTtlMs: 86_400_000,     // expire events older than 24 hours
});

// After 2000 appends, only the latest 1000 remain
// Events older than 24h are also excluded from reads
```

### 6. CAS conflict detection

```typescript
// Two concurrent writers — only one wins
const [r1, r2] = await Promise.all([
  backend.append("orders", {
    type: "update",
    data: { status: "shipped" },
    expectedSequence: 5,       // I think current seq is 5
  }),
  backend.append("orders", {
    type: "update",
    data: { status: "cancelled" },
    expectedSequence: 5,       // I also think current seq is 5
  }),
]);

// Exactly one succeeds, one gets CONFLICT error
const winner = [r1, r2].find((r) => r.ok);
const loser  = [r1, r2].find((r) => !r.ok);
// loser.error.code === "CONFLICT"
```

---

## Extracted L0u Packages

Two utility packages were extracted as part of this feature to eliminate duplication:

### `@koi/sqlite-utils`

Shared SQLite utilities used by both `events-sqlite` and `store-sqlite`.

| Export | Purpose |
|--------|---------|
| `openDb(dbPath)` | Opens SQLite with WAL, NORMAL sync, foreign keys, busy timeout, cache tuning |
| `mapSqliteError(e, context)` | Maps SQLite errors to `KoiError` codes (CONFLICT, INTERNAL, etc.) |
| `wrapSqlite(fn, context)` | Wraps a sync SQLite call in `Result<T, KoiError>` |

### `@koi/event-delivery`

Shared subscription delivery chain used by both `events-sqlite` and `events-memory`.

| Export | Purpose |
|--------|---------|
| `createDeliveryManager(callbacks, config?)` | Manages subscriptions, serialized delivery, retry, DLQ, replay |
| `DeliveryCallbacks` | Backend provides: `persistPosition`, `persistDeadLetter`, `readStream`, `removeDeadLetter` |
| `DeliveryConfig` | Optional: `maxDeadLetters` (default 1000, FIFO eviction) |

```
                ┌──────────────────────┐
                │  @koi/event-delivery │  ← shared chain
                └──────────┬───────────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       events-memory  events-sqlite  events-nexus (future)
         no-op CB      SQLite CB     Nexus RPC CB
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
   │ In-memory (tests) │ │ bun:sqlite   │ │  Multi-node      │
   │ ✅ Available       │ │ ✅ Available  │ │  🔜 #397         │
   └──────────────────┘ └──────────────┘ └──────────────────┘
```

---

## Performance Characteristics

| Concern | Design choice |
|---------|---------------|
| Write throughput | WAL mode — readers don't block writers |
| Query speed | Prepared statements compiled eagerly at factory time |
| Atomicity | `db.transaction()` for CAS + insert + evict in one call |
| Storage layout | `WITHOUT ROWID` on events — composite PK is the B-tree key, no hidden rowid |
| Index overhead | Minimal — composite PK `(stream_id, sequence)` + unique on `id` + DLQ index on `subscription_name` |
| Memory | Bounded DLQ via `maxDeadLetters` (default 1000, FIFO eviction) |
| Startup | Schema migrations via `PRAGMA user_version` — idempotent, no-op on reopen |
| Shutdown | `PRAGMA optimize` before close for query planner tuning |

---

## Testing

### Unit tests (141 total across all affected packages)

```bash
bun test packages/events-sqlite/src/sqlite-backend.test.ts
```

Three describe blocks:

| Block | DB mode | Tests |
|-------|---------|-------|
| Contract tests | `:memory:` | All `EventBackend` contract tests via `runEventBackendContractTests()` |
| Persistence tests | Temp file | Close/reopen, sequence continuity, DLQ persistence, schema idempotency, PRAGMA integrity_check |
| Eviction tests | `:memory:` | FIFO cap, firstSequence after eviction, evicted events excluded from reads, subscription replay after eviction |

### E2E tests (8 tests, real Anthropic API)

```bash
E2E_TESTS=1 bun test packages/events-sqlite/src/__tests__/e2e.test.ts
```

| # | Test | What it proves |
|---|------|----------------|
| 1 | Full lifecycle | register → transition → real LLM call → terminate, all persisted |
| 2 | Crash recovery | Close DB, reopen, registry rebuilds from events |
| 3 | Multi-agent concurrent | 2 agents + 2 parallel LLM calls on shared SQLite |
| 4 | Middleware chain | `onSessionStart`/`onSessionEnd`/`onAfterTurn` fire correctly |
| 5 | Subscription + replay | Replay from position 0, live delivery of new events |
| 6 | CAS conflict | Concurrent transitions, exactly one wins, persists after rebuild |
| 7 | Token metrics | inputTokens/outputTokens/totalTokens non-zero, monotonic sequences |
| 8 | Deregister + rebuild | Agent absent after rebuild, audit trail preserved |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    EventBackend, EventEnvelope, KoiError, Result            │
                                                             │
L0u @koi/sqlite-utils ──── openDb, mapSqliteError ──────────┤
L0u @koi/event-delivery ── createDeliveryManager ───────────┤
L0u @koi/hash ──────────── generateUlid ────────────────────┤
                                                             ▼
L2  @koi/events-sqlite ◄────────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```

**Dev-only dependencies** (`@koi/engine`, `@koi/engine-pi`, `@koi/registry-event-sourced`, `@koi/test-utils`) are used in E2E tests but are not runtime imports.
