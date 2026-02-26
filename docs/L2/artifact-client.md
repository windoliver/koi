# @koi/artifact-client — Universal Artifact Storage

Persistent, pluggable artifact storage for Koi agents. Provides a single `ArtifactClient` interface backed by three swappable stores (InMemory, SQLite, Nexus) and an optional LRU cache wrapper. Agents use this to save, load, search, update, and remove versioned artifacts — tools, skills, configs, or any structured content — without coupling to a specific storage backend.

---

## Why It Exists

Koi agents produce and consume artifacts at runtime: forged tools, generated configs, skill definitions, evaluation results. These artifacts need:

- **Persistence** — survive restarts (SQLite, Nexus)
- **Discovery** — tag-based AND-match search, text search, pagination
- **Integrity** — SHA-256 content hashing, conflict detection on duplicate IDs
- **Performance** — LRU caching with dual-limit eviction (entry count + byte size)
- **Swappability** — same interface whether you're running tests (InMemory), local dev (SQLite), or production (Nexus)

Without this package, every feature that stores artifacts would reinvent file I/O, caching, search, and error handling.

---

## Architecture

`@koi/artifact-client` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0-utility packages (`@koi/hash`), plus Bun built-ins (`bun:sqlite`, `fetch`) for storage backends.

```
┌────────────────────────────────────────────────────────┐
│  @koi/artifact-client  (L2)                            │
│                                                        │
│  types.ts          ← Artifact, ArtifactId, query types │
│  client.ts         ← ArtifactClient interface          │
│  errors.ts         ← error factories + validation      │
│  hash.ts           ← SHA-256 content hashing           │
│  memory-store.ts   ← Map-based ephemeral store         │
│  sqlite-store.ts   ← bun:sqlite persistent store       │
│  nexus-store.ts    ← Nexus JSON-RPC remote store       │
│  cached-client.ts  ← LRU cache decorator               │
│  index.ts          ← public API surface                │
│                                                        │
├────────────────────────────────────────────────────────┤
│  Dependencies                                          │
│                                                        │
│  @koi/core   (L0)   KoiError, Result, JsonObject       │
│  @koi/hash   (L0u)  computeContentHash (SHA-256)       │
│  bun:sqlite  (rt)   built-in SQLite binding            │
│  fetch       (rt)   standard Fetch API (Nexus RPC)     │
└────────────────────────────────────────────────────────┘
```

---

## The Artifact Model

Every artifact stored through this package conforms to the `Artifact` type:

```typescript
interface Artifact {
  readonly id: ArtifactId            // Branded string — unique identifier
  readonly name: string              // Human-readable name
  readonly description: string       // What this artifact does / contains
  readonly content: string           // Stringified payload (JSON, markdown, etc.)
  readonly contentType: string       // MIME type (e.g., "application/json")
  readonly contentHash?: ContentHash // SHA-256 of content (auto-computed)
  readonly sizeBytes: number         // UTF-8 byte length of content
  readonly tags: readonly string[]   // Tag-based discovery (AND-match in search)
  readonly metadata: JsonObject      // Extensible domain-specific data
  readonly createdBy: string         // Agent or user who created this
  readonly createdAt: number         // Unix timestamp (ms)
  readonly updatedAt: number         // Unix timestamp (ms)
}
```

`ArtifactId` and `ContentHash` are branded string types — you cannot accidentally pass a `ContentHash` where an `ArtifactId` is expected.

---

## ArtifactClient Interface

All stores implement the same 6-method contract:

```
┌─────────────────────────────────────────────────────────────┐
│  ArtifactClient                                             │
│                                                             │
│  save(artifact)        → Result<void, KoiError>             │
│  load(id)              → Result<Artifact, KoiError>         │
│  search(query)         → Result<ArtifactPage, KoiError>     │
│  update(id, updates)   → Result<void, KoiError>             │
│  remove(id)            → Result<void, KoiError>             │
│  exists(id)            → Result<boolean, KoiError>          │
│                                                             │
│  All methods return Promise<Result<T, KoiError>>            │
│  Expected failures → typed Result (never throws)            │
│  Unexpected failures → thrown Error with cause chain         │
└─────────────────────────────────────────────────────────────┘
```

| Method | Success | CONFLICT | NOT_FOUND | VALIDATION |
|--------|---------|----------|-----------|------------|
| `save` | Stores artifact | ID already exists | — | Empty ID |
| `load` | Returns artifact | — | ID missing | Empty ID |
| `search` | Returns page | — | — | Negative limit/offset |
| `update` | Applies partial update | — | ID missing | Empty ID |
| `remove` | Deletes artifact | — | ID missing | Empty ID |
| `exists` | Returns boolean | — | — | Empty ID |

When `content` is updated, `contentHash` and `sizeBytes` are automatically recomputed.

---

## Three Store Backends

### Store Selection Guide

```
                    ┌─────────────────┐
                    │  Which store?   │
                    └────────┬────────┘
                             │
                 ┌───────────┼───────────┐
                 ▼           ▼           ▼
          ┌──────────┐ ┌──────────┐ ┌──────────┐
          │ InMemory │ │  SQLite  │ │  Nexus   │
          │          │ │          │ │          │
          │ Tests &  │ │ Local    │ │ Remote   │
          │ ephemeral│ │ dev &    │ │ prod &   │
          │ use      │ │ single   │ │ multi    │
          │          │ │ node     │ │ node     │
          └──────────┘ └──────────┘ └──────────┘
```

| Concern | InMemory | SQLite | Nexus |
|---------|----------|--------|-------|
| Persistence | None (process lifetime) | Disk file | Remote server |
| Setup | Zero config | File path | URL + API key |
| Search | Client-side filter/sort | SQL indices + WHERE | Glob + client-side filter |
| Concurrency | Single process | WAL mode (concurrent reads) | Multi-node via HTTP |
| Dependencies | None | `bun:sqlite` (built-in) | `fetch` (built-in) |
| Best for | Tests, scratch state | Local dev, single-node prod | Multi-node, shared state |

### InMemory Store

```typescript
import { createInMemoryArtifactStore } from "@koi/artifact-client";

const store = createInMemoryArtifactStore();
```

Map-based. Fast. Gone when the process exits. Ideal for tests and the contract test suite.

### SQLite Store

```typescript
import { createSqliteArtifactStore } from "@koi/artifact-client";

const store = createSqliteArtifactStore({ dbPath: "./artifacts.db" });
// ... use store ...
store.close(); // optional — closes the database handle
```

Uses Bun's built-in `bun:sqlite` with:
- **WAL journal mode** + **foreign keys enabled** (`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON`)
- **Normalized tags** in a separate `artifact_tags` table with AND-match via `HAVING COUNT(DISTINCT tag) = N`
- **Cascade deletes** — removing an artifact automatically removes its tags via `ON DELETE CASCADE`
- **Prepared statements** for all operations (parameterized, no SQL injection)
- **Batch tag loading** to avoid N+1 queries in search results
- **Indices** on `createdBy`, `contentType`, `contentHash`, `createdAt`, `updatedAt`, and tag lookups (no index on `name` — sorting by name scans the result set)

Schema:

```
┌──────────────────────────────┐       ┌────────────────────────────────────┐
│  artifacts                   │       │  artifact_tags                     │
│                              │       │                                    │
│  id          TEXT PK         │──1:N─>│  artifactId TEXT FK CASCADE        │
│  name        TEXT NOT NULL   │       │  tag        TEXT NOT NULL          │
│  description TEXT NOT NULL   │       │  PK(artifactId, tag)              │
│  content     TEXT NOT NULL   │       └────────────────────────────────────┘
│  contentType TEXT NOT NULL   │
│  contentHash TEXT            │
│  sizeBytes   INTEGER NOT NULL│
│  metadata    TEXT NOT NULL   │  (JSON, DEFAULT '{}')
│  createdBy   TEXT NOT NULL   │
│  createdAt   INTEGER NOT NULL│
│  updatedAt   INTEGER NOT NULL│
└──────────────────────────────┘
```

### Nexus Store

```typescript
import { createNexusArtifactStore } from "@koi/artifact-client";

const store = createNexusArtifactStore({
  baseUrl: "http://nexus:2026",
  apiKey: process.env.NEXUS_API_KEY!,
  basePath: "/artifacts",       // default
});
```

Stores each artifact as a self-contained JSON file at `{basePath}/{id}.json` via Nexus JSON-RPC 2.0. Uses five RPC methods: `write`, `read`, `exists`, `delete`, and `glob`. Search is implemented client-side: glob all files, read in parallel, filter/sort/paginate locally. This means search cost scales with total artifact count, not result set size.

```
Agent                              Nexus Server
  │                                    │
  │  POST { "method": "write", ... }   │  save / update
  │ ──────────────────────────────────>│
  │  { "result": null }                │
  │ <──────────────────────────────────│
  │                                    │
  │  POST { "method": "read", ... }    │  load
  │ ──────────────────────────────────>│
  │  { "result": "<json string>" }     │
  │ <──────────────────────────────────│
  │                                    │
  │  POST { "method": "exists", ... }  │  exists / save guard
  │ ──────────────────────────────────>│
  │  { "result": true }                │
  │ <──────────────────────────────────│
  │                                    │
  │  POST { "method": "delete", ... }  │  remove
  │ ──────────────────────────────────>│
  │  { "result": null }                │
  │ <──────────────────────────────────│
  │                                    │
  │  POST { "method": "glob", ... }    │  search (list all)
  │ ──────────────────────────────────>│
  │  { "result": ["/artifacts/a.json", │
  │               "/artifacts/b.json"] }│
  │ <──────────────────────────────────│
```

**Note:** `update` performs a read-modify-write cycle (load → merge → write) — not atomic across concurrent requests.

HTTP and RPC errors are mapped to typed `KoiError` codes:

| Error Source | KoiError Code | Retryable |
|-------------|---------------|-----------|
| HTTP 404 | `NOT_FOUND` | No |
| HTTP 401 / 403 | `PERMISSION` | No |
| HTTP 409 | `CONFLICT` | No |
| HTTP 429 | `RATE_LIMIT` | Yes |
| HTTP 5xx / network | `EXTERNAL` | Yes |
| JSON parse failure | `INTERNAL` | No |

---

## LRU Cache Wrapper

Wrap any `ArtifactClient` with an LRU cache for hot-path performance:

```typescript
import {
  createSqliteArtifactStore,
  createCachedArtifactClient,
} from "@koi/artifact-client";

const sqlite = createSqliteArtifactStore({ dbPath: "./artifacts.db" });

const store = createCachedArtifactClient(sqlite, {
  maxEntries: 500,          // default: 1000
  maxSizeBytes: 100_000_000, // 100 MB (default: 50 MB)
  ttlMs: 600_000,           // 10 min (default: 5 min)
});
```

### How the Cache Works

```
            ┌──────────────────────────────────────────┐
            │           LRU Cache                      │
            │                                          │
            │  head ──> [MRU] ──> [...] ──> [LRU] <── tail
            │                                          │
            │  Evict from tail when:                   │
            │    entries.size >= maxEntries     OR      │
            │    totalSizeBytes + new > maxSizeBytes    │
            │                                          │
            │  Expire on access when:                  │
            │    now - insertedAt > ttlMs               │
            └──────────────────────────────────────────┘
```

### Cache Behavior per Operation

| Operation | Checks Cache | Updates Cache | Always Delegates |
|-----------|-------------|---------------|------------------|
| `load` | Yes (TTL) | Populates on miss | Only on miss |
| `save` | No | Populates on success | Yes |
| `exists` | Yes (presence) | No | Only on miss |
| `update` | No | Invalidates | Yes |
| `remove` | No | Invalidates | Yes |
| `search` | No | No | Yes |

Key design decisions:
- **`exists` cache hit can only return `true`** — a cached artifact proves existence; `false` results from the inner store are never cached, so repeated `exists` calls on missing artifacts always delegate
- **`update` invalidates** rather than merging — partial updates are complex; next `load` re-fetches
- **`search` never cached** — results are query-dependent, not addressable by artifact ID
- **Dual-limit eviction** — entry count checked first, then byte size; prevents both count and memory blow-up

---

## Search and Query

All stores support the same query interface:

```typescript
interface ArtifactQuery {
  readonly tags?: readonly string[]      // AND-match: artifact must have ALL
  readonly createdBy?: string            // Exact match
  readonly contentType?: string          // Exact match
  readonly textSearch?: string           // Case-insensitive substring on "name + ' ' + description"
  readonly limit?: number                // Default: 100
  readonly offset?: number               // Default: 0
  readonly sortBy?: "createdAt" | "updatedAt" | "name"  // Default: "createdAt"
  readonly sortOrder?: "asc" | "desc"    // Default: "desc"
}
```

Returns an `ArtifactPage`:

```typescript
interface ArtifactPage {
  readonly items: readonly Artifact[]    // Page slice
  readonly total: number                 // Total matches (before pagination)
  readonly offset: number
  readonly limit: number
}
```

**Tag AND-match example:** Searching `tags: ["forge", "tool"]` returns only artifacts that have *both* tags — not artifacts with either one.

---

## Error Handling

All stores follow consistent error semantics using `Result<T, KoiError>`:

```
  ┌────────────────┐     ┌────────────┐     ┌──────────────┐
  │ Expected error │     │ Error code │     │ Retryable?   │
  ├────────────────┤     ├────────────┤     ├──────────────┤
  │ ID not found   │ ──> │ NOT_FOUND  │ ──> │ No           │
  │ Duplicate ID   │ ──> │ CONFLICT   │ ──> │ No           │
  │ Bad input      │ ──> │ VALIDATION │ ──> │ No           │
  │ Data corrupt   │ ──> │ INTERNAL   │ ──> │ No           │
  │ Network/I/O    │ ──> │ EXTERNAL   │ ──> │ Yes          │
  └────────────────┘     └────────────┘     └──────────────┘
```

Expected failures are returned as typed `Result` values — never thrown. Callers pattern-match on `error.code`:

```typescript
const result = await store.load(id);
if (!result.ok) {
  switch (result.error.code) {
    case "NOT_FOUND":
      // artifact doesn't exist
      break;
    case "EXTERNAL":
      if (result.error.retryable) {
        // network issue — retry with backoff
      }
      break;
  }
}
```

---

## API Reference

### Factory Functions

#### `createInMemoryArtifactStore()`

Returns `ArtifactClient`. No config. Map-based. Process-lifetime only.

#### `createSqliteArtifactStore(config)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.dbPath` | `string` | File path or `":memory:"` |

Returns `ArtifactClient & { readonly close: () => void }`. Call `close()` to release the database handle.

#### `createNexusArtifactStore(config)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.baseUrl` | `string` | — | Nexus server URL |
| `config.apiKey` | `string` | — | Bearer token |
| `config.basePath` | `string` | `"/artifacts"` | Storage path prefix |
| `config.fetch` | `typeof fetch` | `globalThis.fetch` | Injectable for testing |

Returns `ArtifactClient`.

#### `createCachedArtifactClient(inner, options?)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `inner` | `ArtifactClient` | — | Store to wrap |
| `options.maxEntries` | `number` | `1000` | Max cached artifacts |
| `options.maxSizeBytes` | `number` | `50 MB` | Max cache memory |
| `options.ttlMs` | `number` | `300_000` (5 min) | Time-to-live per entry |

Returns `ArtifactClient`.

### Utility Functions

#### `computeContentHash(content)`

Synchronous SHA-256 hash of a string. Returns a branded `ContentHash` (64-char hex).

#### `artifactId(id)` / `contentHash(hash)`

Branded type constructors — identity casts for compile-time safety.

### Types

| Type | Description |
|------|-------------|
| `Artifact` | The stored entity — ID, name, content, tags, metadata, timestamps |
| `ArtifactId` | Branded `string` for artifact identity |
| `ContentHash` | Branded `string` for SHA-256 hashes |
| `ArtifactClient` | 6-method store interface (`save`, `load`, `search`, `update`, `remove`, `exists`) |
| `ArtifactQuery` | Filter/sort/paginate parameters for `search()` |
| `ArtifactPage` | Paginated search result (`items`, `total`, `offset`, `limit`) |
| `ArtifactUpdate` | Partial update fields (all optional) |
| `SqliteStoreConfig` | `{ dbPath: string }` |
| `NexusStoreConfig` | `{ baseUrl, apiKey, basePath?, fetch? }` |
| `CacheOptions` | `{ maxEntries?, maxSizeBytes?, ttlMs? }` |

---

## Examples

### Save, Load, Search

```typescript
import {
  createInMemoryArtifactStore,
  artifactId,
  computeContentHash,
} from "@koi/artifact-client";
import type { Artifact } from "@koi/artifact-client";

const store = createInMemoryArtifactStore();

const content = JSON.stringify({ schema: "v1", handler: "echo" });
const artifact: Artifact = {
  id: artifactId("tool-echo-v1"),
  name: "Echo Tool",
  description: "Echoes user input back",
  content,
  contentType: "application/json",
  contentHash: computeContentHash(content),
  sizeBytes: new TextEncoder().encode(content).byteLength,
  tags: ["forge", "tool", "echo"],
  metadata: { category: "utilities" },
  createdBy: "forge-agent",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// Save
const saveResult = await store.save(artifact);
// saveResult.ok === true

// Load
const loadResult = await store.load(artifactId("tool-echo-v1"));
if (loadResult.ok) {
  console.log(loadResult.value.name); // "Echo Tool"
}

// Search by tags (AND-match)
const searchResult = await store.search({
  tags: ["forge", "tool"],
  sortBy: "name",
  sortOrder: "asc",
  limit: 10,
});
if (searchResult.ok) {
  console.log(`${searchResult.value.total} tools found`);
}
```

### SQLite with Cache

```typescript
import {
  createSqliteArtifactStore,
  createCachedArtifactClient,
} from "@koi/artifact-client";

const sqlite = createSqliteArtifactStore({ dbPath: "./data/artifacts.db" });
const store = createCachedArtifactClient(sqlite, {
  maxEntries: 500,
  ttlMs: 600_000, // 10 minutes
});

// First load hits SQLite, populates cache
const first = await store.load(artifactId("my-tool"));

// Second load served from cache (no SQLite query)
const second = await store.load(artifactId("my-tool"));

// Update invalidates cache — next load re-fetches from SQLite
await store.update(artifactId("my-tool"), { name: "Updated Name" });
const third = await store.load(artifactId("my-tool")); // cache miss → SQLite
```

### Nexus Remote Store

```typescript
import { createNexusArtifactStore } from "@koi/artifact-client";

const store = createNexusArtifactStore({
  baseUrl: "http://nexus:2026",
  apiKey: process.env.NEXUS_API_KEY!,
  basePath: "/agents/forge-output",
});

// Same ArtifactClient interface — save, load, search, etc.
const result = await store.search({
  createdBy: "forge-agent",
  contentType: "application/json",
  limit: 50,
});
```

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────┐
    KoiError, Result, JsonObject, RETRYABLE_DEFAULTS   │
                                                       │
L0u @koi/hash ──────────────────────────┐             │
    computeContentHash (SHA-256)        │             │
                                        ▼             ▼
L2  @koi/artifact-client ◄─────────────┴─────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ bun:sqlite and fetch are runtime built-ins
```

**Dev-only dependencies** (`@koi/engine`, `@koi/engine-pi`, `@koi/test-utils`) are used in tests but are not runtime imports.
