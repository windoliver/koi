# @koi/session-store — Durable Session Persistence for Crash Recovery

Pluggable persistence layer for agent session records, pending outbound frames, and engine state. Provides two backends (in-memory and SQLite) behind the `SessionPersistence` contract defined in L0.

---

## Why It Exists

When a Koi node crashes mid-conversation, agents lose their position in the gateway session, any buffered outbound frames, and opaque engine state. `@koi/session-store` makes crash recovery possible by persisting:

- **Session records** — which agents were running, their gateway session IDs, manifest snapshots, sequence counters, and optionally the latest engine state for fast stateful recovery
- **Pending frames** — outbound messages that were queued but not yet acknowledged by the gateway
- **Recovery plan** — a single `recover()` call returns everything needed to re-dispatch agents after a restart

Without this package, every node restart would lose all agent state and require manual intervention.

---

## Architecture

`@koi/session-store` is an **L2 feature package** — depends only on L0 (`@koi/core`) and L0u utilities (`@koi/errors`, `@koi/sqlite-utils`).

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/session-store  (L2)                                        │
│                                                                   │
│  types.ts          ← SessionStoreConfig, re-exports from L0      │
│  memory-store.ts   ← In-memory backend (tests, ephemeral nodes)  │
│  sqlite-store.ts   ← SQLite backend (production, durable)        │
│  index.ts          ← Public API surface                          │
│                                                                   │
├──────────────────────────────────────────────────────────────────│
│  Dependencies                                                     │
│                                                                   │
│  @koi/core  (L0)   SessionPersistence, SessionRecord,            │
│                     PendingFrame, RecoveryPlan, Result, KoiError  │
│  @koi/errors (L0u)  extractMessage                               │
│  @koi/sqlite-utils (L0u)  openDb                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Recovery Model

Recovery is **transcript-based with inline engine state**. The `SessionRecord` carries an optional `lastEngineState` field that holds the opaque engine state for stateful engines. This avoids a separate checkpoint table and simplifies the recovery flow to a single read path.

```
Node crash → Node restart → store.recover()
                                │
                                ▼
                        ┌─────────────────┐
                        │  RecoveryPlan    │
                        │                  │
                        │  sessions[]      │ ← SessionRecord with lastEngineState
                        │  pendingFrames   │ ← Map<sessionId, PendingFrame[]>
                        │  skipped[]       │ ← corrupt rows (if any)
                        └─────────────────┘
                                │
                                ▼
              For each session:
              ├── engine.loadState(session.lastEngineState)  ← if available
              ├── transcript.load(session.sessionId)          ← conversation history
              └── host.dispatch(pid, manifest, engine)        ← re-dispatch agent
```

### Key Types

```typescript
interface SessionRecord {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly manifestSnapshot: AgentManifest;
  readonly seq: number;           // outbound frame sequence
  readonly remoteSeq: number;     // inbound frame sequence
  readonly connectedAt: number;   // unix ms
  readonly lastPersistedAt: number; // unix ms of last save
  readonly lastEngineState?: EngineState | undefined; // opaque engine state
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface RecoveryPlan {
  readonly sessions: readonly SessionRecord[];
  readonly pendingFrames: ReadonlyMap<string, readonly PendingFrame[]>;
  readonly skipped: readonly SkippedRecoveryEntry[];
}
```

---

## Backends

### In-Memory (`createInMemorySessionPersistence`)

- Zero dependencies, zero I/O
- Data lives in `Map` instances — lost on process exit
- Used for: tests, ephemeral dev nodes, E2E scripts

```typescript
import { createInMemorySessionPersistence } from "@koi/session-store";

const store = createInMemorySessionPersistence();
```

### SQLite (`createSqliteSessionPersistence`)

- WAL mode for concurrent reads during writes
- Configurable durability: `"os"` (default — fsync) or `"process"` (no fsync, faster but data at risk on OS crash)
- Schema auto-migrates on open (column renames, new columns added via `ALTER TABLE`)
- Used for: production nodes, any node that needs crash recovery

```typescript
import { createSqliteSessionPersistence } from "@koi/session-store";

const store = createSqliteSessionPersistence({
  dbPath: "/var/koi/sessions.db",
  durability: "os",    // default — durable to OS crashes
});
```

---

## SessionPersistence Contract

Both backends implement the `SessionPersistence` interface from L0:

| Method | Description |
|--------|-------------|
| `saveSession(record)` | Upsert a session record (keyed by sessionId) |
| `loadSession(sessionId)` | Load a single session by ID |
| `removeSession(sessionId)` | Delete a session and its associated data |
| `listSessions(filter?)` | List sessions, optionally filtered by agentId |
| `savePendingFrame(frame)` | Persist an outbound frame for replay after reconnect |
| `loadPendingFrames(sessionId)` | Load pending frames for a session, ordered by index |
| `clearPendingFrames(sessionId)` | Remove all pending frames for a session |
| `removePendingFrame(frameId)` | Remove a single pending frame by ID |
| `recover()` | Build a complete `RecoveryPlan` from all stored data |
| `close()` | Release resources (close SQLite handle, clear maps) |

All methods return `Result<T, KoiError>` — expected failures are typed, not thrown.

---

## Engine State Persistence

Stateful engines (those implementing `EngineAdapter.saveState()`) can persist their opaque state in the session record's `lastEngineState` field. This enables fast recovery without replaying the full transcript.

```typescript
// Saving engine state during normal operation
const engineState = await engine.saveState();
await store.saveSession({
  ...existingRecord,
  lastPersistedAt: Date.now(),
  lastEngineState: engineState,  // { engineId: "claude", data: {...} }
});

// Recovering engine state after crash
const plan = await store.recover();
for (const session of plan.sessions) {
  if (session.lastEngineState && engine.loadState) {
    await engine.loadState(session.lastEngineState);
  }
}
```

Engines without `saveState()`/`loadState()` (e.g., `engine-pi`) simply don't populate this field — the session record is saved without it, and recovery falls back to transcript replay.

---

## Examples

### Basic Crash Recovery

```typescript
import { createSqliteSessionPersistence } from "@koi/session-store";
import { agentId, sessionId } from "@koi/core";

const store = createSqliteSessionPersistence({ dbPath: "./sessions.db" });

// Save session when agent dispatched
await store.saveSession({
  sessionId: sessionId("gw-session-123"),
  agentId: agentId("agent-1"),
  manifestSnapshot: agentManifest,
  seq: 0,
  remoteSeq: 0,
  connectedAt: Date.now(),
  lastPersistedAt: Date.now(),
  metadata: {},
});

// Periodically update with engine state
await store.saveSession({
  ...record,
  lastPersistedAt: Date.now(),
  lastEngineState: await engine.saveState(),
});

// After crash: recover all agents
const plan = await store.recover();
// plan.sessions → [{agentId: "agent-1", lastEngineState: {...}, ...}]
// plan.pendingFrames → Map of unsent outbound frames
```

### Pending Frame Replay

```typescript
// Before sending to gateway, persist the frame
await store.savePendingFrame({
  frameId: "pf-001",
  sessionId: "gw-session-123",
  agentId: agentId("agent-1"),
  frameType: "agent:message",
  payload: { text: "Hello from agent" },
  orderIndex: 0,
  createdAt: Date.now(),
  retryCount: 0,
});

// After reconnect: replay pending frames
const frames = await store.loadPendingFrames("gw-session-123");
for (const frame of frames.value) {
  await gateway.send(frame);
  await store.removePendingFrame(frame.frameId);
}
```

---

## SQLite Schema

The SQLite backend uses two tables:

```sql
CREATE TABLE IF NOT EXISTS session_records (
  sessionId    TEXT PRIMARY KEY,
  agentId      TEXT NOT NULL,
  manifest     TEXT NOT NULL,         -- JSON
  seq          INTEGER NOT NULL DEFAULT 0,
  remoteSeq    INTEGER NOT NULL DEFAULT 0,
  connectedAt  INTEGER NOT NULL,
  lastPersistedAt INTEGER NOT NULL,
  lastEngineState TEXT,               -- JSON, nullable
  metadata     TEXT NOT NULL DEFAULT '{}'  -- JSON
);

CREATE TABLE IF NOT EXISTS pending_frames (
  frameId     TEXT PRIMARY KEY,
  sessionId   TEXT NOT NULL,
  agentId     TEXT NOT NULL,
  frameType   TEXT NOT NULL,
  payload     TEXT NOT NULL,          -- JSON
  orderIndex  INTEGER NOT NULL DEFAULT 0,
  createdAt   INTEGER NOT NULL,
  retryCount  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pf_session
  ON pending_frames(sessionId, orderIndex);
```

WAL mode is enabled for concurrent read access during writes.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Engine state in `SessionRecord`, not separate table | One read path for recovery — simpler, faster, no join needed |
| `lastEngineState` is optional | Stateless engines (engine-pi) don't need it; only populated by engines with `saveState()` |
| WAL mode for SQLite | Allows concurrent reads during writes — critical for recovery during active operation |
| `Result<T, KoiError>` everywhere | Expected failures (NOT_FOUND, validation) are typed; callers handle them explicitly |
| `recover()` returns everything in one call | Minimizes I/O round-trips; node calls once at startup |
| `SkippedRecoveryEntry` for corrupt rows | Graceful degradation — one corrupt row doesn't block all recovery |
| In-memory backend shares contract tests | Both backends verified against identical behavior via `runSessionPersistenceContractTests` |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────────┐
    SessionPersistence, SessionRecord, PendingFrame,              │
    RecoveryPlan, SkippedRecoveryEntry, SessionFilter,            │
    EngineState, Result, KoiError, AgentId, SessionId             │
                                                                   ▼
L0u @koi/errors, @koi/sqlite-utils ────────────────────────────┐
                                                                   ▼
L2  @koi/session-store <──────────────────────────────────────┘
    imports from L0 and L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
```
