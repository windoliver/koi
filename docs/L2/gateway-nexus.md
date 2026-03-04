# @koi/gateway-nexus — Nexus-Backed Gateway State for HA

Nexus-backed implementations of gateway state stores (SessionStore, NodeRegistry, SurfaceStore) enabling multi-instance high-availability deployment. All stores use local-first reads with async Nexus persistence, and gracefully degrade to in-memory when Nexus is unavailable.

---

## Why It Exists

The gateway holds three critical in-memory stores:

- **SessionStore** — active WebSocket sessions
- **NodeRegistry** — connected agent nodes and their tools
- **SurfaceStore** — rendered HTML/JSON surfaces

Without persistence, if the gateway process dies all state is lost. Running multiple gateway instances is impossible because they can't share state. This package solves both problems:

- **Durability** — State persists to Nexus (JSON-RPC file store) and survives process restarts
- **Multi-instance** — Multiple gateways read/write the same Nexus namespace, sharing sessions, nodes, and surfaces
- **Graceful degradation** — If Nexus goes down, stores fall back to in-memory with zero downtime. When Nexus recovers, stores reconnect automatically
- **Zero-latency reads** — All reads are served from local cache (sync). Only writes and cache misses touch the network

---

## Architecture

`@koi/gateway-nexus` is an **L2 feature package** — depends only on `@koi/core` (L0) and L0u utilities.

```
┌───────────────────────────────────────────────────────┐
│  @koi/gateway-nexus  (L2)                             │
│                                                       │
│  config.ts               ← GatewayNexusConfig + defaults  │
│  degradation.ts          ← pure state machine (healthy/degraded) │
│  write-queue.ts          ← coalescing async write queue │
│  poll-sync.ts            ← generic polling utility     │
│  nexus-session-store.ts  ← write-through SessionStore  │
│  nexus-node-registry.ts  ← local-projection NodeRegistry │
│  nexus-surface-store.ts  ← lazy-fetch SurfaceStore     │
│  index.ts                ← public API surface          │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Dependencies                                         │
│                                                       │
│  @koi/core          (L0)   Result, KoiError            │
│  @koi/gateway-types (L0u)  SessionStore, NodeRegistry, SurfaceStore │
│  @koi/nexus-client  (L0u)  NexusClient, readJson, paths │
└───────────────────────────────────────────────────────┘
```

### Data Flow

```
  Client read (get)          Client write (set/create)
        │                            │
        ▼                            ▼
  ┌─────────────┐            ┌─────────────┐
  │ Local Cache  │◄───────── │ Local Cache  │  (sync return)
  │  (Map)       │           │  (Map)       │
  └──────┬──────┘            └──────┬──────┘
         │ cache miss                │ async
         ▼                           ▼
  ┌─────────────┐            ┌─────────────┐
  │ Nexus read   │           │ Write Queue  │  (coalesces by path)
  │ (readJson)   │           │ (flushes)    │
  └──────┬──────┘            └──────┬──────┘
         │                           │
         ▼                           ▼
  ┌──────────────────────────────────────┐
  │           Nexus Server               │
  │  global/gateway/sessions/{id}.json   │
  │  global/gateway/nodes/{id}.json      │
  │  global/gateway/surfaces/{id}.json   │
  └──────────────────────────────────────┘
```

---

## Quick Start

### Standalone (direct factory)

```typescript
import { createNexusSessionStore } from "@koi/gateway-nexus";
import { createNexusClient } from "@koi/nexus-client";

const client = createNexusClient({
  baseUrl: "http://nexus:2026",
  apiKey: "my-key",
});

const handle = createNexusSessionStore({
  client,
  config: {
    nexusUrl: "http://nexus:2026",
    apiKey: "my-key",
    instanceId: "gateway-1",       // identifies this instance
    degradation: { failureThreshold: 3 },
    writeQueue: { flushIntervalMs: 500 },
  },
});

// Use like any SessionStore — same interface
handle.store.set(session);              // sync return, async Nexus write
const r = handle.store.get("sess-1");   // sync from cache, or async Nexus fetch

// Check health
handle.degradation().mode; // "healthy" | "degraded"

// Cleanup
await handle.dispose();
```

### Via gateway-stack (recommended)

```typescript
import { createGatewayStack } from "@koi/gateway-stack";

const stack = createGatewayStack(
  {
    gateway: { maxConnections: 5_000 },
    canvas: { port: 8081 },
    nexus: {                           // ← add this to enable HA
      nexusUrl: "http://nexus:2026",
      apiKey: "my-key",
    },
  },
  { transport, auth, canvasAuth },
);

await stack.start(8080);
// Sessions now persist to Nexus automatically
```

---

## Key Types

| Type | Purpose |
|------|---------|
| `GatewayNexusConfig` | Full config: nexusUrl, apiKey, instanceId, degradation, writeQueue, polling |
| `DegradationConfig` | Failure threshold + probe interval for degraded mode |
| `WriteQueueConfig` | Max queue size + flush interval for coalesced writes |
| `NexusSessionStoreHandle` | SessionStore + degradation status + dispose |
| `NexusNodeRegistryHandle` | NodeRegistry + degradation status + dispose |
| `NexusSurfaceStoreHandle` | SurfaceStore + degradation status + dispose |
| `DegradationState` | Current mode (healthy/degraded), failure count, timestamps |

---

## Store Behavior

### SessionStore (write-through cache)

- `get(id)` → local Map first. Cache miss → Nexus `readJson()`. Degraded + miss → NOT_FOUND
- `set(session)` → write local Map (sync). New sessions flush to Nexus immediately; updates coalesce
- `delete(id)` → delete local. Immediate Nexus delete
- `entries()` → local Map only (sync — required by heartbeat sweep)
- Sessions track `ownerInstance` for CAS ownership transfer on resume

### NodeRegistry (local projection)

- All reads are local-only (sync): `lookup()`, `findByTool()`, `nodes()`
- `register()` → local + immediate Nexus write
- `deregister()` → local + immediate Nexus delete
- `updateHeartbeat/updateCapacity/updateTools` → local + coalesced Nexus write

### SurfaceStore (lazy content fetch)

- `get(id)` → local cache. Miss → lazy-fetch full content from Nexus
- `create(id, content)` → compute SHA-256 hash, write local, immediate Nexus write
- `update(id, content, expectedHash?)` → CAS check, local write, coalesced Nexus write
- LRU eviction is local-only (configurable `maxSurfaces`, default 10,000)

---

## Degradation

A pure state machine tracks Nexus health:

```
  healthy ──(N consecutive failures)──→ degraded
  degraded ──(successful probe)──→ healthy
```

When degraded:
- **Reads** return from cache. Cache misses return NOT_FOUND (no Nexus call)
- **Writes** succeed locally and queue for Nexus (delivered when healthy)
- **Probing** periodically tests Nexus availability (configurable interval, default 10s)

Defaults: 3 failures → degraded, 10s probe interval.

---

## Write Queue

Writes are coalesced by path to reduce Nexus load:

- Multiple updates to the same session/node/surface merge into one Nexus write
- Create and delete operations bypass coalescing (flush immediately)
- Bounded queue (default 1,000 entries) — drops oldest on overflow
- Configurable flush interval (default 500ms)
