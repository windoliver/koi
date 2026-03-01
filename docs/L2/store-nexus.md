# @koi/store-nexus — Nexus-Backed Persistent ForgeStore

Remote `ForgeStore` implementation backed by a Nexus JSON-RPC filesystem server. Stores each brick artifact as a JSON file, enabling multi-node deployments where all nodes share the same brick catalog.

**Layer:** L2 (depends on `@koi/core`, `@koi/nexus-client`, `@koi/validation`)

---

## Why It Exists

The in-memory `ForgeStore` loses all forged bricks on process exit. For production deployments with multiple agent nodes, bricks must:

1. **Survive restarts** — a brick forged in session 1 must be loadable in session 2
2. **Be shared across nodes** — a CLI node and a server node must see the same bricks
3. **Use the same interface** — consumers see `ForgeStore`, unaware of the backing store

`@koi/store-nexus` solves this for distributed deployments by storing bricks on a Nexus server accessible to all nodes.

For single-node/CLI usage, see `@koi/store-sqlite` which stores bricks in a local SQLite database.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/store-nexus  (L2)                                          │
│                                                                    │
│  nexus-store.ts    ← createNexusForgeStore() factory               │
│  batch-map.ts      ← bounded-concurrency batch utility             │
│  index.ts          ← Public API surface                            │
│                                                                    │
├──────────────────────────────────────────────────────────────────  │
│  Dependencies                                                      │
│                                                                    │
│  @koi/core          (L0)   ForgeStore, ForgeQuery, BrickArtifact,  │
│                             BrickUpdate, Result, KoiError,          │
│                             StoreChangeEvent, RETRYABLE_DEFAULTS    │
│  @koi/nexus-client  (L0u)  createNexusClient(), NexusClient        │
│  @koi/validation    (L0u)  matchesBrickQuery(), sortBricks(),       │
│                             applyBrickUpdate(),                     │
│                             validateBrickArtifact()                  │
└──────────────────────────────────────────────────────────────────  ┘
```

---

## How It Works

Each brick is stored as a JSON file at `{basePath}/{id}.json` on the Nexus server. All operations use the Nexus JSON-RPC filesystem API.

```
  Node A (CLI)              Node B (Server)          Node C (Worker)
  ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
  │ save(brick)──┼────┐    │ search({})──┼────┐     │ load(id)───┼────┐
  └─────────────┘    │    └─────────────┘    │     └─────────────┘    │
                     │                       │                        │
                     ▼                       ▼                        ▼
              ┌─────────────────────────────────────────────────────────┐
              │                   Nexus Server                          │
              │                   (JSON-RPC)                            │
              │                                                         │
              │   /forge/bricks/                                        │
              │   ├── brick_math-calc.json                              │
              │   ├── brick_json-parser.json                            │
              │   └── brick_csv-reader.json                             │
              └─────────────────────────────────────────────────────────┘
```

### Search Pipeline

Search uses client-side filtering: glob all brick files, read each in bounded batches, then post-filter and sort.

```
  ForgeQuery { kind: "tool", tags: ["math"], orderBy: "fitness" }
                          │
                          ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  1. Glob            glob /forge/bricks/*.json → file list    │
  │  2. Batch read      read each file (concurrency=10)          │
  │  3. Validate        JSON.parse → validateBrickArtifact()     │
  │  4. Post-filter     matchesBrickQuery() on each brick        │
  │  5. Sort + filter   sortBricks() with minFitnessScore        │
  │  6. Limit           slice(0, query.limit)                    │
  └──────────────────────────────────────────────────────────────┘
                          │
                          ▼
               Result<BrickArtifact[]>
```

### Key Operations

```
save(brick)
  │
  └── write RPC → {basePath}/{id}.json  (upsert — overwrites if exists)

load(id)
  │
  └── read RPC → JSON.parse → validateBrickArtifact()

search(query)
  │
  ├── glob RPC → list all *.json files
  ├── batchMap(files, read, concurrency=10)
  ├── matchesBrickQuery() post-filter
  ├── sortBricks() + minFitnessScore
  └── apply limit

update(id, updates)
  │
  ├── read existing brick
  ├── applyBrickUpdate(existing, updates) → new brick
  └── write RPC (full overwrite)

remove(id)
  │
  ├── exists RPC → NOT_FOUND if missing
  └── delete RPC

exists(id)
  │
  └── exists RPC → boolean
```

---

## Configuration

```typescript
interface NexusForgeStoreConfig {
  readonly baseUrl: string;              // Nexus server URL
  readonly apiKey: string;               // Bearer token for auth
  readonly basePath?: string;            // Default: "/forge/bricks"
  readonly concurrency?: number;         // Batch read parallelism. Default: 10
  readonly fetch?: typeof globalThis.fetch;  // Injectable for testing
}
```

| Config | Default | Description |
|--------|---------|-------------|
| `baseUrl` | (required) | Nexus JSON-RPC server endpoint |
| `apiKey` | (required) | API key sent as `Authorization: Bearer` |
| `basePath` | `"/forge/bricks"` | Directory prefix for brick JSON files |
| `concurrency` | `10` | Max parallel reads during `search()` |
| `fetch` | `globalThis.fetch` | Override for testing with fake fetch |

---

## Examples

### Basic — Persistent Brick Storage

```typescript
import { createNexusForgeStore } from "@koi/store-nexus";
import type { ToolArtifact } from "@koi/core";

const store = createNexusForgeStore({
  baseUrl: "https://nexus.example.com/rpc",
  apiKey: process.env.NEXUS_API_KEY!,
});

// Save a forged brick
const result = await store.save(brick);
if (!result.ok) throw new Error(result.error.message);

// Search for math tools
const tools = await store.search({ kind: "tool", tags: ["math"] });
```

### Testing with Fake Nexus

```typescript
import { createNexusForgeStore } from "@koi/store-nexus";
import { createFakeNexusFetch } from "@koi/test-utils";

const store = createNexusForgeStore({
  baseUrl: "http://fake-nexus",
  apiKey: "test-key",
  fetch: createFakeNexusFetch(),  // in-memory JSON-RPC server
});
```

### Custom Base Path and Concurrency

```typescript
const store = createNexusForgeStore({
  baseUrl: "https://nexus.example.com/rpc",
  apiKey: process.env.NEXUS_API_KEY!,
  basePath: "/my-project/bricks",
  concurrency: 5,  // limit parallel reads
});
```

### Watch for Local Mutations

```typescript
const unsub = store.watch?.((event) => {
  console.log(`${event.kind}: ${event.brickId}`);
});

await store.save(brick);   // logs "saved: brick_abc"
await store.remove(id);    // logs "removed: brick_abc"

unsub?.();
```

---

## API Reference

### Factory

| Function | Returns | Description |
|----------|---------|-------------|
| `createNexusForgeStore(config)` | `ForgeStore` | Creates a Nexus-backed persistent store |

### ForgeStore Methods

| Method | Description |
|--------|-------------|
| `save(brick)` | Write brick as JSON file. Upsert semantics. |
| `load(id)` | Read and validate brick. Returns `NOT_FOUND` if missing. |
| `search(query)` | Glob + batch read + filter + sort. Client-side filtering. |
| `remove(id)` | Delete brick file. Returns `NOT_FOUND` if missing. |
| `update(id, updates)` | Read-modify-write with `applyBrickUpdate()`. |
| `exists(id)` | Check if brick file exists on Nexus. |
| `watch(listener)` | Subscribe to local mutation events. Returns unsubscribe fn. |
| `dispose()` | Clear change listeners. No connection to close. |

### Types

| Type | Description |
|------|-------------|
| `NexusForgeStoreConfig` | `{ baseUrl, apiKey, basePath?, concurrency?, fetch? }` |
| `ForgeStore` | L0 interface — save, load, search, remove, update, exists, watch?, dispose? |
| `ForgeQuery` | `{ kind?, scope?, tags?, text?, limit?, orderBy?, minFitnessScore?, ... }` |
| `BrickUpdate` | `{ lifecycle?, trustTier?, scope?, usageCount?, tags?, fitness?, ... }` |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| One JSON file per brick | Simple, human-readable, easy to debug. No schema migration needed. |
| Client-side filtering | Nexus has no query engine — glob + read + filter is the only option |
| Bounded batch reads | Prevents overwhelming Nexus with unbounded parallel requests |
| `readBrick()` handles not-found | Single code path for load/update error handling, avoids redundant exists check |
| `watch()` is local-only | Nexus has no push notification. Watch fires on local mutations only. |
| No advisory locking yet | `AdvisoryLock` interface exists in L0 but isn't wired. Update uses read-modify-write without locking. |
| `validateBrickArtifact()` on every read | Defense against corrupt or tampered JSON files |
| `RETRYABLE_DEFAULTS` for error codes | Consistent retry semantics across all Koi packages |

---

## Swappable Backends

Both `@koi/store-sqlite` and `@koi/store-nexus` implement the same L0 `ForgeStore` interface. Consumers never know which backend is active:

```
                      ForgeStore           (L0 interface)
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
    InMemoryForgeStore  SQLite       Nexus
    (volatile, tests)  (single      (multi-node,
                        node,        shared via
                        file-based)  JSON-RPC)
```

---

## Related

- Issue: #206 — feat: persistent ForgeStore backends (Nexus + SQLite)
- `@koi/store-sqlite` — SQLite backend for single-node usage
- `@koi/nexus-client` — JSON-RPC client used by this package
- `@koi/validation` — `matchesBrickQuery()`, `sortBricks()`, `applyBrickUpdate()`

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────────┐
    ForgeStore, ForgeQuery, BrickArtifact, BrickUpdate,          │
    BrickId, Result, KoiError, StoreChangeEvent,                 │
    RETRYABLE_DEFAULTS, notFound()                               │
                                                                  │
L0u @koi/nexus-client ────────────────────────────────────────  │
    createNexusClient(), NexusClient                              │
                                                                  │
L0u @koi/validation ──────────────────────────────────────────  │
    matchesBrickQuery(), sortBricks(), applyBrickUpdate(),        │
    validateBrickArtifact()                                       │
                                                                  ▼
L2  @koi/store-nexus <─────────────────────────────────────────  ┘
    imports from L0 and L0u only
    x never imports @koi/engine (L1)
    x never imports peer L2 packages
    ~ package.json: {
        "@koi/core": "workspace:*",
        "@koi/nexus-client": "workspace:*",
        "@koi/validation": "workspace:*"
      }
```
