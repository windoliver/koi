# @koi/snapshot-store-sqlite — Persistent DAG Snapshot Storage

SQLite-backed `SnapshotChainStore<T>` with WAL mode, content-hash deduplication, full DAG topology (ancestor walking, forking, pruning), and in-memory head tracking for O(1) lookups. Drop-in replacement for the in-memory store from `@koi/snapshot-chain-store`.

---

## Why It Exists

`@koi/snapshot-chain-store` provides an in-memory `SnapshotChainStore<T>` — fast but volatile. State vanishes on process exit. For autonomous agents that operate over hours or days, losing harness snapshots means losing all task progress, summaries, and artifacts.

`@koi/snapshot-store-sqlite` adds **durable persistence** to the same L0 interface:

- **Survives restarts** — snapshots persist across process exits and crashes
- **WAL mode** — concurrent reads during writes, no reader blocking
- **Content-hash dedup** — `skipIfUnchanged` avoids redundant writes when data hasn't changed
- **Configurable durability** — "process" (default, fast) or "os" (FULL sync for power-loss safety)
- **Same interface** — consumers see `SnapshotChainStore<T>`, unaware of the backing store

Without this package, long-running agents would lose all semantic history on restart.

---

## Architecture

`@koi/snapshot-store-sqlite` is an **L0u utility package** — it depends on L0 (`@koi/core`) and peer L0u packages (`@koi/hash`, `@koi/sqlite-utils`).

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/snapshot-store-sqlite  (L0u)                                │
│                                                                    │
│  types.ts            ← SqliteSnapshotStoreConfig                   │
│  sqlite-store.ts     ← createSqliteSnapshotStore<T>() factory      │
│  index.ts            ← Public API surface                          │
│                                                                    │
├──────────────────────────────────────────────────────────────────  │
│  Dependencies                                                      │
│                                                                    │
│  @koi/core          (L0)   ChainId, NodeId, SnapshotNode,          │
│                             SnapshotChainStore, PruningPolicy,      │
│                             ForkRef, AncestorQuery, Result, KoiError│
│  @koi/hash          (L0u)  computeContentHash()                    │
│  @koi/sqlite-utils  (L0u)  openDb(), mapSqliteError()              │
└──────────────────────────────────────────────────────────────────  ┘
```

---

## How It Works

The store uses two tables: a **nodes table** for snapshot data and a **members table** for chain membership. A node can belong to multiple chains (via fork). Heads and sequence counters are tracked in-memory for O(1) lookup, initialized from the DB on construction.

```
┌──────────────────────────────────────────────────────────────────┐
│                    SQLite Database (WAL mode)                      │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  snapshot_nodes                                            │    │
│  │  ┌──────────┬────────────┬──────────────┬──────┬───────┐ │    │
│  │  │ node_id  │ parent_ids │ content_hash │ data │ meta  │ │    │
│  │  │ (PK)     │ JSON[]     │ SHA-256      │ JSON │ JSON  │ │    │
│  │  └──────────┴────────────┴──────────────┴──────┴───────┘ │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  snapshot_nodes_members                                    │    │
│  │  ┌──────────┬─────────┬────────────┬─────┐               │    │
│  │  │ chain_id │ node_id │ created_at │ seq │               │    │
│  │  │ (PK)     │ (PK)    │ DESC index │     │               │    │
│  │  └──────────┴─────────┴────────────┴─────┘               │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                    │
├──────────────────────────────────────────────────────────────────│
│  In-Memory Cache                                                   │
│                                                                    │
│  chainHeads: Map<ChainId, NodeId>     ← O(1) head lookup          │
│  chainSeqs:  Map<ChainId, number>     ← monotonic seq counter     │
│                                                                    │
│  Loaded from DB on construction, updated on put/fork/prune         │
└──────────────────────────────────────────────────────────────────┘
```

### Key Operations

```
put(chainId, data, parentIds, metadata)
  │
  ├── validate parent IDs exist
  ├── computeContentHash(data) → hash
  ├── skipIfUnchanged? compare hash with head's content_hash
  ├── INSERT INTO snapshot_nodes (node_id, parent_ids, hash, data, ...)
  ├── INSERT INTO snapshot_nodes_members (chain_id, node_id, seq)
  └── update chainHeads + chainSeqs in memory

ancestors(query)
  │
  ├── BFS from startNodeId
  ├── follow parent_ids links (index-based queue, O(1) dequeue)
  ├── respect maxDepth limit
  └── return visited nodes in BFS order

fork(sourceNodeId, newChainId)
  │
  ├── verify source node exists
  ├── INSERT INTO members (newChainId, sourceNodeId, ...)
  └── new chain shares the source node as its head

prune(chainId, policy)
  │
  ├── list chain members (newest first)
  ├── mark removable by retainCount and/or retainDuration
  ├── protect chain head if retainBranches !== false
  ├── DELETE memberships, DELETE orphaned nodes
  └── re-derive head from remaining members
```

---

## Configuration

```typescript
interface SqliteSnapshotStoreConfig {
  readonly dbPath: string;                    // ":memory:" for tests, file path for persistence
  readonly durability?: "process" | "os";     // Default: "process" (PRAGMA synchronous = NORMAL)
  readonly tableName?: string;                // Default: "snapshot_nodes" — multiple stores per DB
}
```

### Durability Modes

| Mode | SQLite PRAGMA | Survives | Use Case |
|------|---------------|----------|----------|
| `"process"` (default) | `synchronous = NORMAL` | Process crashes | Development, most production |
| `"os"` | `synchronous = FULL` | OS crashes, power loss | Critical data, compliance |

Both modes use WAL journal mode (set by `@koi/sqlite-utils`).

---

## Examples

### Basic — Persistent Harness Store

```typescript
import { createSqliteSnapshotStore } from "@koi/snapshot-store-sqlite";
import type { HarnessSnapshot, ChainId, NodeId } from "@koi/core";

const store = createSqliteSnapshotStore<HarnessSnapshot>({
  dbPath: "./data/harness-snapshots.db",
});

const chainId = "agent-1-main" as ChainId;

// Put a snapshot
const result = store.put(chainId, snapshot, [], { session: 1 });
if (!result.ok) throw new Error(result.error.message);

const node = result.value; // SnapshotNode<HarnessSnapshot>

// Get the chain head
const head = store.head(chainId);
// head.ok === true, head.value === node

// Clean up
store.close();
```

### Skip Unchanged — Avoid Redundant Writes

```typescript
// First put: stores the snapshot
store.put(chainId, snapshot, [], {}, { skipIfUnchanged: true });

// Second put with identical data: returns undefined (no write)
const result = store.put(chainId, snapshot, [firstNodeId], {}, { skipIfUnchanged: true });
// result.ok === true, result.value === undefined
```

### Fork and Prune

```typescript
// Fork a chain at a specific node
const forkResult = store.fork(nodeId, "agent-1-branch" as ChainId, "experiment");
// forkResult.value.parentNodeId === nodeId

// Prune old snapshots, keeping the latest 5
const pruned = store.prune(chainId, { retainCount: 5 });
// pruned.value === number of nodes removed
```

### In-Memory for Tests

```typescript
const store = createSqliteSnapshotStore<HarnessSnapshot>({
  dbPath: ":memory:",
});
// Identical API — no file I/O
```

### With Autonomous Agent

```typescript
import { createSqliteSnapshotStore } from "@koi/snapshot-store-sqlite";
import { createLongRunningHarness } from "@koi/long-running";
import { createHarnessScheduler } from "@koi/harness-scheduler";
import { createAutonomousAgent } from "@koi/autonomous";

const snapshotStore = createSqliteSnapshotStore<HarnessSnapshot>({
  dbPath: "./data/snapshots.db",
  durability: "os",  // maximum durability
});

const harness = createLongRunningHarness({
  harnessId: harnessId("agent-1"),
  agentId: agentId("agent-1"),
  harnessStore: snapshotStore,   // ← persistent store
  sessionPersistence,
});

const scheduler = createHarnessScheduler({ harness });
const agent = createAutonomousAgent({ harness, scheduler });
```

---

## API Reference

### Factory Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `createSqliteSnapshotStore<T>(config)` | `SnapshotChainStore<T> & { close }` | Creates a persistent snapshot store |

### Store Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `put(cid, data, parentIds, meta?, opts?)` | `(ChainId, T, NodeId[], Record?, PutOptions?) → Result<SnapshotNode<T> \| undefined>` | Insert snapshot, returns undefined if skipped |
| `get(nid)` | `(NodeId) → Result<SnapshotNode<T>>` | Retrieve node by ID |
| `head(cid)` | `(ChainId) → Result<SnapshotNode<T> \| undefined>` | Get chain head (O(1) from cache) |
| `list(cid)` | `(ChainId) → Result<readonly SnapshotNode<T>[]>` | All nodes in chain, newest first |
| `ancestors(query)` | `(AncestorQuery) → Result<readonly SnapshotNode<T>[]>` | BFS ancestor walk with maxDepth |
| `fork(sourceId, newChainId, label)` | `(NodeId, ChainId, string) → Result<ForkRef>` | Fork chain at a node |
| `prune(cid, policy)` | `(ChainId, PruningPolicy) → Result<number>` | Remove old nodes, return count |
| `close()` | `() → void` | Close DB connection, reject further operations |

### Types

| Type | Description |
|------|-------------|
| `SqliteSnapshotStoreConfig` | `{ dbPath, durability?, tableName? }` |
| `SnapshotChainStore<T>` | L0 interface — put, get, head, list, ancestors, fork, prune |
| `SnapshotNode<T>` | `{ nodeId, chainId, parentIds, contentHash, data, createdAt, metadata }` |
| `PutOptions` | `{ skipIfUnchanged? }` |
| `PruningPolicy` | `{ retainCount?, retainDuration?, retainBranches? }` |
| `ForkRef` | `{ parentNodeId, label }` |
| `AncestorQuery` | `{ startNodeId, maxDepth? }` |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Two tables (nodes + members) | A node can belong to multiple chains via fork — avoids data duplication |
| In-memory head cache | O(1) head lookup without hitting SQLite on every `head()` call |
| Monotonic `seq` counter per chain | Deterministic ordering within the same millisecond |
| Prepared statements for all queries | Avoids re-parsing SQL on every call — significant perf improvement |
| Index-based BFS for ancestors | Avoids O(n) `Array.shift()` — uses `queueIdx` pointer instead |
| Table name validation regex | Prevents SQL injection via crafted table names |
| `computeContentHash` for dedup | Deterministic serialization (sorted keys) ensures identical objects hash identically |
| Store owns DB connection | Single `openDb()` call at construction, `close()` for cleanup |

---

## Swappable Backends

Both `@koi/snapshot-chain-store` (in-memory) and `@koi/snapshot-store-sqlite` implement the same L0 `SnapshotChainStore<T>` interface. Consumers never know which backend is active:

```
                    SnapshotChainStore<T>   (L0 interface)
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
  @koi/snapshot-chain-store    @koi/snapshot-store-sqlite
  (in-memory, volatile)       (SQLite, persistent)
                                        │
                              Future: @koi/store-nexus
                              (remote JSON-RPC, distributed)
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────────┐
    ChainId, NodeId, SnapshotNode, SnapshotChainStore,           │
    PruningPolicy, ForkRef, AncestorQuery, PutOptions,           │
    Result, KoiError                                              │
                                                                   │
L0u @koi/hash ──────────────────────────────────────────────────│
    computeContentHash()                                          │
                                                                   │
L0u @koi/sqlite-utils ──────────────────────────────────────────│
    openDb(), mapSqliteError()                                    │
                                                                   ▼
L0u @koi/snapshot-store-sqlite <─────────────────────────────────┘
    imports from L0 and L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    ~ package.json: {
        "@koi/core": "workspace:*",
        "@koi/hash": "workspace:*",
        "@koi/sqlite-utils": "workspace:*"
      }
```
