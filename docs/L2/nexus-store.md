# @koi/nexus-store — Unified Nexus Storage Adapters

Consolidated Nexus-backed persistence for all five storage domains: forge (bricks), events, snapshots, sessions, and memory. One package replaces the previous scattered implementations (`@koi/store-nexus`, `@koi/events-nexus`) and adds three new Nexus backends.

**Layer:** L2 (depends on `@koi/core`, `@koi/nexus-client`, `@koi/event-delivery`, `@koi/validation`)

---

## Why It Exists

Before this package, each storage domain had its own Nexus adapter package, each reinventing:
- Path construction and namespace conventions
- Error mapping from Nexus RPC errors to `KoiError`
- Search via glob + batch read + client-side filtering
- Listener notification patterns

This led to ~2,000 LOC of duplicated patterns across 2 packages, with 3 domains (snapshots, sessions, memory) lacking Nexus backends entirely.

`@koi/nexus-store` solves this by:
1. **Unifying all Nexus adapters** under one consistent namespace convention
2. **Sharing helpers** (error mapping, path validation, batch reads) across all domains
3. **Adding missing backends** — snapshots, sessions, and memory now have Nexus persistence
4. **Hardening security** — path traversal validation on all user-provided IDs

---

## Architecture

```
@koi/nexus-store (L2)
├── forge.ts       ← createNexusForgeStore()      → ForgeStore
├── events.ts      ← createNexusEventBackend()     → EventBackend
├── snapshots.ts   ← createNexusSnapshotStore()    → SnapshotChainStore<T>
├── session.ts     ← createNexusSessionStore()     → SessionPersistence
├── memory.ts      ← createNexusMemoryBackend()    → FactPersistenceBackend
└── shared/
    ├── nexus-helpers.ts  ← wrapNexusError(), validatePathSegment()
    └── batch-map.ts      ← bounded-concurrency batch utility
```

### Namespace Convention

<!-- FROZEN: Namespace contract locked per #922. Changes require a new issue. -->

All data is organized under a unified agent-scoped namespace. Canonical paths are defined in `@koi/nexus-client/paths.ts` — the single source of truth. No leading slashes (NexusPath convention).

> **Migration note (v0 → v1):** Prior to #922, `DEFAULT_BASE_PATH` constants used leading slashes (e.g., `"/session"`) which violates the `NexusPath` contract. Any pre-#922 persisted data that was addressed with leading-slash paths will need re-addressing if the Nexus server treats `/session/...` and `session/...` as distinct paths. No automated migration is provided — this is a pre-release breaking change.

```
agents/{agentId}/
├── bricks/{brickId}.json                        ← forge artifacts
├── events/
│   ├── streams/{streamId}/
│   │   ├── meta.json                            ← event stream metadata
│   │   └── events/{seq:10}.json                 ← individual events (zero-padded)
│   ├── subscriptions/{name}.json                ← subscription positions
│   └── dead-letters/{entryId}.json              ← failed deliveries
├── snapshots/{chainId}/{nodeId}.json            ← snapshot chains
├── session/
│   ├── records/{sessionId}.json                 ← session records
│   └── pending/{sessionId}/{frameId}.json       ← pending frames
├── memory/entities/{slug}.json                  ← memory facts
├── workspace/...                                ← free-form file storage
└── mailbox/                                     ← REST+SSE adapter (not file-backed)

global/
├── bricks/{brickId}.json                        ← shared brick artifacts
└── gateway/
    ├── sessions/{id}.json
    ├── nodes/{id}.json
    └── surfaces/{id}.json

groups/{groupId}/
└── scratch/{path}                               ← group scratchpad
```

---

## What It Enables

### Before (scattered, incomplete)

```typescript
// 2 packages, each with its own RPC patterns
import { createNexusForgeStore } from "@koi/store-nexus";
import { createNexusEventBackend } from "@koi/events-nexus";

// No Nexus backends for snapshots, sessions, or memory — local-only
```

### After (unified, complete)

```typescript
// One package, five subpath exports
import { createNexusForgeStore } from "@koi/nexus-store/forge.js";
import { createNexusEventBackend } from "@koi/nexus-store/events.js";
import { createNexusSnapshotStore } from "@koi/nexus-store/snapshots.js";
import { createNexusSessionStore } from "@koi/nexus-store/session.js";
import { createNexusMemoryBackend } from "@koi/nexus-store/memory.js";

// All five adapters use the same NexusClient, same namespace, same error handling
```

### Pluggable memory persistence

```typescript
import { createFsMemory, createFsFactBackend } from "@koi/memory-fs";
import { createNexusMemoryBackend } from "@koi/nexus-store/memory.js";

// Local filesystem (default — backward compatible)
const local = createFsMemory({ baseDir: "./data" });

// Nexus-backed — facts persist to a shared server
const nexusBackend = createNexusMemoryBackend({ baseUrl, apiKey, agentId });
// Pass backend to createFactStore() or use in FsMemoryConfig
```

---

## Adapters

### Forge (`forge.js`)

Nexus-backed `ForgeStore` for brick artifacts. Replaces `@koi/store-nexus`.

```typescript
const store = createNexusForgeStore({
  baseUrl: "https://nexus.example.com/rpc",
  apiKey: process.env.NEXUS_API_KEY!,
});

await store.save(brick);
const results = await store.search({ kind: "tool", tags: ["math"] });
```

### Events (`events.js`)

Nexus-backed `EventBackend` with deferred batch eviction. Replaces `@koi/events-nexus`.

```typescript
const backend = createNexusEventBackend({
  baseUrl: "https://nexus.example.com/rpc",
  apiKey: process.env.NEXUS_API_KEY!,
});

await backend.append("stream-1", event);
const result = await backend.read("stream-1", { after: 0, limit: 100 });
```

### Snapshots (`snapshots.js`)

Nexus-backed `SnapshotChainStore<T>` — new, no predecessor.

```typescript
const store = createNexusSnapshotStore<MyState>({
  baseUrl: "https://nexus.example.com/rpc",
  apiKey: process.env.NEXUS_API_KEY!,
});

const putResult = await store.put(chainId, stateData, parentIds);
const ancestors = await store.ancestors({ startNodeId: nodeId, maxDepth: 10 });
```

### Sessions (`session.js`)

Nexus-backed `SessionPersistence` — new, no predecessor.

```typescript
const persistence = createNexusSessionStore({
  baseUrl: "https://nexus.example.com/rpc",
  apiKey: process.env.NEXUS_API_KEY!,
});

await persistence.saveSession(record);
await persistence.saveCheckpoint(checkpoint);
const latest = await persistence.loadLatestCheckpoint(agentId);
```

### Memory (`memory.js`)

Nexus-backed `FactPersistenceBackend` for `@koi/memory-fs` — new, no predecessor.

```typescript
const backend = createNexusMemoryBackend({
  baseUrl: "https://nexus.example.com/rpc",
  apiKey: process.env.NEXUS_API_KEY!,
  agentId: agentId("my-agent"),
});

// Use with createFactStore()
const facts = await backend.readFacts("user-preferences");
await backend.writeFacts("user-preferences", updatedFacts);
```

---

## Security

All adapters validate user-provided IDs with `validatePathSegment()` before constructing Nexus paths:

- Rejects path traversal (`../`, `/`)
- Rejects null bytes
- Rejects empty strings
- Returns `Result<void, KoiError>` with `VALIDATION` error code

---

## Testing

Each adapter runs both domain-specific contract tests and Nexus namespace tests using `createFakeNexusFetch()` from `@koi/test-utils`:

```
173 tests across 5 files:
  forge.test.ts      — ForgeStore contract + path validation
  events.test.ts     — EventBackend contract + deferred eviction
  snapshots.test.ts  — SnapshotChainStore contract + DAG walking
  session.test.ts    — SessionPersistence contract + checkpoint eviction
  memory.test.ts     — FactPersistenceBackend contract + entity listing
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| One package, five subpath exports | Tree-shakeable: consumers only pay for adapters they import |
| Shared `wrapNexusError()` | Single error mapping function eliminates 5x duplication |
| `validatePathSegment()` on all IDs | Defense-in-depth against path traversal attacks |
| Agent-scoped namespace | Natural isolation boundary — agents can't read each other's data |
| Client-side filtering for search | Nexus has no query engine; glob + batch read is the only option |
| Deferred eviction in events | Avoids O(k) eviction on every append hot path |

---

## Related

- Issue: #750 — Unified Nexus namespace
- `@koi/nexus-client` — JSON-RPC client shared by all adapters
- `@koi/memory-fs` — Memory system with pluggable `FactPersistenceBackend`
- `@koi/snapshot-chain-store` — In-memory snapshot store (local alternative)
- `@koi/test-utils` — `createFakeNexusFetch()` for adapter testing

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────────────────┐
    ForgeStore, EventBackend, SnapshotChainStore, SessionPersistence,│
    FactPersistenceBackend, Result, KoiError, RETRYABLE_DEFAULTS     │
                                                                      │
L0u @koi/nexus-client ──────────────────────────────────────────────│
    createNexusClient(), NexusClient                                  │
                                                                      │
L0u @koi/event-delivery ────────────────────────────────────────────│
    createListenerSet()                                               │
                                                                      │
L0u @koi/validation ────────────────────────────────────────────────│
    matchesBrickQuery(), sortBricks(), validateBrickArtifact()        │
                                                                      ▼
L2  @koi/nexus-store <──────────────────────────────────────────────┘
    imports from L0 and L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```
