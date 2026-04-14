# @koi/snapshot-store-sqlite

L2 storage adapter implementing `SnapshotChainStore<T>` from `@koi/core` over SQLite.

Persistent DAG snapshot storage with WAL mode, content-hash deduplication, full DAG topology (ancestor walking, forking, pruning), in-memory head tracking for O(1) lookups, recursive-CTE ancestor queries, and integrated mark-and-sweep CAS blob garbage collection.

---

## Why It Exists

Generic snapshot DAG storage that two unrelated L2 packages need:

- **`@koi/checkpoint`** (#1625) — uses `T = AgentSnapshot` for session-level rollback (`/rewind <n>`)
- **deterministic-replay** (sibling of #1625) — uses the same chain topology to record/replay engine traces

Without a shared L2 adapter, both packages would reinvent the same SQLite schema. The store is generic over `T`, so both consumers use the same tables and the same `SnapshotChainStore<T>` interface from `@koi/core`.

Ports the v1 SQLite schema from `archive/v1/packages/mm/snapshot-chain-store/src/sqlite-store.ts` with two improvements driven by the #1625 design review:

- **Recursive-CTE ancestor walks** — replaces v1's BFS with N+1 queries (Issue 16)
- **Mark-and-sweep blob GC integrated into prune** — v1 left orphan blob cleanup to callers (Issue 13)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/snapshot-store-sqlite  (L2 storage adapter)                 │
│                                                                    │
│  types.ts            ← SqliteSnapshotStoreConfig                   │
│  sqlite-store.ts     ← createSnapshotStoreSqlite<T>() factory      │
│  schema.ts           ← table DDL, pragmas                          │
│  cte.ts              ← recursive ancestor walk query               │
│  gc.ts               ← mark-and-sweep blob sweeper                 │
│  index.ts            ← public API                                  │
│                                                                    │
├────────────────────────────────────────────────────────────────── │
│  Dependencies                                                      │
│                                                                    │
│  @koi/core          (L0)   ChainId, NodeId, SnapshotNode,          │
│                             SnapshotChainStore, PruningPolicy,      │
│                             ForkRef, AncestorQuery, Result, KoiError│
│  @koi/errors        (L0u)  KoiError factories                       │
│  bun:sqlite         (Bun built-in, not an npm dep)                 │
└──────────────────────────────────────────────────────────────────  ┘
```

---

## Schema

Three tables, deliberately small:

```sql
CREATE TABLE snapshot_nodes (
  node_id      TEXT PRIMARY KEY,
  chain_id     TEXT NOT NULL,              -- "home" chain returned by get()
  parent_ids   TEXT NOT NULL DEFAULT '[]', -- JSON array of NodeId
  content_hash TEXT NOT NULL,              -- SHA-256 of payload, for skip-if-unchanged
  data         TEXT NOT NULL,              -- JSON-serialized payload T
  created_at   INTEGER NOT NULL,           -- Unix ms
  metadata     TEXT NOT NULL DEFAULT '{}'  -- JSON; includes SNAPSHOT_STATUS_KEY
);
CREATE INDEX idx_snapshot_nodes_chain ON snapshot_nodes(chain_id);

CREATE TABLE chain_members (
  chain_id   TEXT NOT NULL,
  node_id    TEXT NOT NULL REFERENCES snapshot_nodes(node_id),
  created_at INTEGER NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,   -- monotonic per-chain ordering
  PRIMARY KEY (chain_id, node_id)
);
CREATE INDEX idx_chain_members_chain ON chain_members(chain_id, created_at DESC, seq DESC);

CREATE TABLE chain_heads (
  chain_id TEXT PRIMARY KEY,
  node_id  TEXT NOT NULL REFERENCES snapshot_nodes(node_id)
);
```

The `chain_members` bridge table is what enables forks: a single `snapshot_nodes` row can belong to multiple `chain_members` rows from different chains. The `chain_heads` table holds the head pointer per chain.

The `snapshot_nodes.chain_id` column records the *home chain* — the chain a node was originally `put` into. It is what `get()` returns in `SnapshotNode<T>.chainId` and never changes after creation, even when the node is forked into other chains. Forks insert into `chain_members` only; they never rewrite `chain_id`.

---

## SQLite Settings

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Concurrent reads while writing |
| `synchronous` | `NORMAL` (default) / `FULL` (config: `durability = "os"`) | NORMAL is durable against app crash; FULL against power loss |
| `wal_autocheckpoint` | `1000` | Bound WAL file growth |
| `foreign_keys` | `ON` | Enforce parent constraints |

---

## In-Memory Caches

Two maps initialized at construction time from a single JOIN query:

```typescript
const chainHeads = new Map<ChainId, NodeId>();    // chainId → current head
const chainSeqs  = new Map<ChainId, number>();    // chainId → next seq
```

`head(chainId)` is O(1) — looks up the in-memory map, then a single indexed `SELECT ... WHERE node_id = ?`. Caches are kept consistent with the DB by every `put` / `fork` / `prune` operation.

---

## Ancestor Walk: Recursive CTE

V1 used a JS-side BFS that issued one `SELECT` per parent (N+1 queries). For deep walks (rewind 50+ turns) this crossed the perceptible-latency threshold. This adapter uses a single recursive CTE:

```sql
WITH RECURSIVE ancestors(node_id, depth) AS (
    SELECT :start_id, 0
  UNION
    SELECT json_each.value, ancestors.depth + 1
    FROM ancestors
    JOIN snapshot_nodes ON snapshot_nodes.node_id = ancestors.node_id
    JOIN json_each(snapshot_nodes.parent_ids)
    WHERE ancestors.depth < :max_depth
)
SELECT n.* FROM snapshot_nodes n
JOIN ancestors a ON n.node_id = a.node_id
ORDER BY a.depth ASC;
```

`UNION` (not `UNION ALL`) deduplicates DAG diamonds where a node has multiple paths to the same ancestor. **One round-trip regardless of depth.** Replaces v1's BFS-with-N+1 pattern.

---

## Mark-and-Sweep Blob GC

The store accepts an optional `blobDir: string` and a payload-side function `extractBlobRefs: (data: T) => readonly string[]`. When `prune()` runs, it:

1. Computes the set of nodes to delete based on the `PruningPolicy`
2. Deletes them in a single transaction (along with the chain head pointer update)
3. Walks all *remaining* live nodes, calls `extractBlobRefs(node.data)`, builds a `Set<string>` of referenced blob hashes
4. Lists the blob directory; deletes any blob whose hash is not in the set

The CAS sweep is **idempotent** — re-running it converges. If `blobDir` is not provided, the GC step is skipped (the deterministic-replay package may not need blob storage at all).

The store does NOT read or write blob *contents* — that's the consumer's responsibility (e.g., `@koi/checkpoint` writes blobs to CAS). The store only owns the blob *directory listing* during GC.

---

## Crash Safety

Per #1625 design review issue 9, the package ships a crash-injection test harness that kills the process between every protocol step and asserts re-run convergence.

| Scenario | Behavior |
|---|---|
| Crash mid-`put` | SQLite transaction rolls back; chain head unchanged |
| Crash mid-`prune` (chain step) | Transaction rolls back; nothing deleted. The in-memory `chainHeads` cache mutation is deferred until AFTER the SQL transaction commits (#1749), so a rolled-back prune cannot poison the cache and serve stale heads to `getOrCreateSession`. |
| Crash mid-blob-sweep | Some orphan blobs may persist; next prune cleans them up |
| Corrupt SQLite (torn header) | Fail-closed at startup with explicit error |
| Missing blob referenced by snapshot | Restore fails gracefully with `BLOB_MISSING` error, never silently corrupts state |

---

## Configuration

```typescript
interface SqliteSnapshotStoreConfig<T> {
  /** Path to SQLite file. Use `:memory:` for tests. */
  readonly path: string;
  /**
   * Optional CAS blob directory. If set, prune sweeps it for orphan blobs
   * referenced by no live snapshot.
   */
  readonly blobDir?: string;
  /**
   * Function to extract blob hashes from a payload, used by GC.
   * Required if `blobDir` is set.
   */
  readonly extractBlobRefs?: (data: T) => readonly string[];
  /**
   * Durability level. "process" = synchronous=NORMAL (app-crash safe).
   * "os" = synchronous=FULL (power-loss safe). Default: "process".
   */
  readonly durability?: "process" | "os";
}
```

### Durability Modes

| Mode | SQLite PRAGMA | Survives | Use Case |
|---|---|---|---|
| `"process"` (default) | `synchronous = NORMAL` | App crashes | Development, most production |
| `"os"` | `synchronous = FULL` | OS crashes, power loss | Critical data, compliance |

Both modes use WAL journal mode.

---

## API

The factory returns a sync-narrowed view of `SnapshotChainStore<T>` — exposed as `SqliteSnapshotStore<T>`. Every method is sync, but the type is structurally compatible with the L0 union interface so callers may upcast for portability.

```typescript
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { chainId, type AgentSnapshot } from "@koi/core";

const store = createSnapshotStoreSqlite<AgentSnapshot>({
  path: "~/.koi/snapshots.sqlite",
  blobDir: "~/.koi/file-history",
  extractBlobRefs: extractBlobRefsFromAgentSnapshot,
  durability: "process",
});

// Implements SnapshotChainStore<AgentSnapshot> from @koi/core
const head = store.head(chainId("session-abc"));
if (!head.ok || head.value === undefined) throw new Error("empty chain");

const ancestors = store.ancestors({
  startNodeId: head.value.nodeId,
  maxDepth: 10,
});

store.prune(chainId("session-abc"), { retainCount: 500 });

// Wipe a chain entirely (used by `Checkpoint.resetSession` on /clear).
// `retainBranches: false` removes the head row too — the prune logic
// updates `chain_heads` BEFORE deleting any `snapshot_nodes` so the
// FK from `chain_heads.node_id` into `snapshot_nodes(node_id)` stays
// satisfied through the transaction (#1749). The replacement head
// (when not removing all rows) is picked from the in-memory survivor
// set, not a SELECT against the still-pre-delete table state.
store.prune(chainId("session-abc"), { retainCount: 0, retainBranches: false });
store.close();
```

### In-Memory for Tests

```typescript
const store = createSnapshotStoreSqlite<AgentSnapshot>({
  path: ":memory:",
});
// Identical API — no file I/O, no GC (no blobDir set)
```

---

## Store Methods

| Method | Signature | Description |
|---|---|---|
| `put(cid, data, parentIds, meta?, opts?)` | `(ChainId, T, NodeId[], Record?, PutOptions?) → Result<SnapshotNode<T> \| undefined>` | Insert snapshot; returns undefined if `skipIfUnchanged` matched |
| `get(nid)` | `(NodeId) → Result<SnapshotNode<T>>` | Retrieve node by ID |
| `head(cid)` | `(ChainId) → Result<SnapshotNode<T> \| undefined>` | Get chain head (O(1) from cache) |
| `list(cid)` | `(ChainId) → Result<readonly SnapshotNode<T>[]>` | All nodes in chain, newest first |
| `ancestors(query)` | `(AncestorQuery) → Result<readonly SnapshotNode<T>[]>` | Recursive-CTE ancestor walk with maxDepth |
| `fork(sourceId, newChainId, label)` | `(NodeId, ChainId, string) → Result<ForkRef>` | Fork chain at a node |
| `prune(cid, policy)` | `(ChainId, PruningPolicy) → Result<number>` | Remove old nodes + sweep orphan blobs; returns chain-node count removed |
| `close()` | `() → void \| Promise<void>` | Close DB connection, reject further operations |

---

## Testing

| Suite | What | Tests |
|---|---|---|
| **Contract suite** | Ported from v1 — put/get/head/ancestors/prune/fork/close behavior | ~14 |
| **Crash injection** | Kill process between every protocol step, assert re-run convergence | ~10–15 |
| **CTE correctness** | Linear chain, deep chain, DAG diamond (no double-visit), depth limit | 4 |
| **Blob GC sweep** | All-orphan, none-orphan, partial, head-protected | 4 |
| **Negative path** | Missing blob, corrupt SQLite, foreign-key violation, fail-closed startup | ~6 |

The crash-injection harness is the test that validates the ordered+idempotent atomicity strategy used by `@koi/checkpoint`. It is not optional.

---

## Design Decisions

| Decision | Rationale |
|---|---|
| Three tables (nodes + members + heads) | A node can belong to multiple chains via fork — avoids data duplication |
| In-memory head cache | O(1) head lookup without hitting SQLite on every `head()` call |
| Monotonic `seq` counter per chain | Deterministic ordering within the same millisecond |
| Prepared statements for all hot queries | Avoids re-parsing SQL on every call |
| Recursive CTE for ancestors | One round-trip regardless of depth; replaces v1 BFS-with-N+1 |
| Mark-and-sweep GC inside prune transaction | Idempotent, crash-safe, no separate background task |
| `extractBlobRefs` is consumer-supplied | Decouples store from payload schema; deterministic-replay can omit blob handling entirely |
| Store does NOT touch blob bytes | CAS reads/writes are the consumer's job; store only owns the blob *directory listing* during GC |
| `bun:sqlite` (no npm dep) | Bun built-in; zero install footprint; same API as `better-sqlite3` |

---

## Layer

L2 — depends on `@koi/core` (L0) and `@koi/errors` (L0u) only. Uses `bun:sqlite` (Bun built-in, not an npm dependency).
