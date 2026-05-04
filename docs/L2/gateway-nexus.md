# @koi/gateway-nexus — Nexus-Backed Gateway State for HA

Nexus-backed `SessionStore` implementation enabling multi-instance high-availability gateway deployment. Local-first reads with async Nexus persistence, graceful degradation to in-memory when Nexus is unavailable.

> v2 scope (Issue #1368): SessionStore only. NodeRegistry + SurfaceStore are deferred until v2 ports those subsystems.

---

## Why It Exists

The gateway's `SessionStore` holds every active WebSocket session. Without persistence, if the process dies all sessions are lost; running multiple gateway instances behind a load balancer is impossible because they can't share session state.

This package solves both problems:

- **Durability** — Sessions persist to Nexus (JSON-RPC file store) and survive process restarts
- **Multi-instance** — Multiple gateways read/write the same Nexus namespace, sharing sessions
- **Graceful degradation** — If Nexus goes down, the store falls back to local cache with zero downtime. When Nexus recovers, writes flush automatically
- **Zero-latency reads** — All cache hits are sync. Only cache misses and writes touch the network

---

## Architecture

`@koi/gateway-nexus` is an **L2 feature package** — depends only on `@koi/core` (L0) and L0u utilities.

```
┌───────────────────────────────────────────────────────┐
│  @koi/gateway-nexus  (L2)                             │
│                                                       │
│  config.ts               ← GatewayNexusConfig + defaults │
│  degradation.ts          ← pure state machine (healthy/degraded) │
│  write-queue.ts          ← coalescing async write queue │
│  nexus-session-store.ts  ← write-through SessionStore  │
│  index.ts                ← public API surface          │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Dependencies                                         │
│                                                       │
│  @koi/core          (L0)   Result, KoiError, notFound  │
│  @koi/gateway-types (L0u)  Session, SessionStore       │
│  @koi/nexus-client  (L0u)  NexusTransport (call-based) │
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
import { createHttpTransport } from "@koi/nexus-client";

const transport = createHttpTransport({ url: "http://nexus:3100" });

const handle = createNexusSessionStore({
  transport,
  config: {
    instanceId: "gateway-1",       // identifies this instance
    degradation: { failureThreshold: 3 },
    writeQueue: { flushIntervalMs: 500 },
  },
});

// Use like any SessionStore — same interface
handle.store.set(session);                    // sync return, async Nexus write
const r = await handle.store.get("sess-1");   // sync cache hit, or async Nexus fetch

// Check health
handle.degradation().mode; // "healthy" | "degraded"

// Cleanup
await handle.dispose();
```

### Via gateway-stack (recommended)

```typescript
import { createGatewayStack } from "@koi/gateway-stack";
import { createHttpTransport } from "@koi/nexus-client";

const stack = createGatewayStack(
  {
    gateway: { maxConnections: 5_000 },
    canvas: { port: 8081 },
    nexus: { instanceId: "gateway-1" }, // ← add this to enable HA
  },
  {
    transport,
    auth,
    canvasAuth,
    nexusTransport: createHttpTransport({ url: "http://nexus:3100" }),
  },
);

await stack.start(8080);
// Sessions now persist to Nexus automatically
```

---

## Key Types

| Type | Purpose |
|------|---------|
| `GatewayNexusConfig` | instanceId, basePath, degradation, writeQueue overrides |
| `DegradationConfig` | Failure threshold + probe interval for degraded mode |
| `WriteQueueConfig` | Max queue size + flush interval for coalesced writes |
| `NexusSessionStoreHandle` | SessionStore + degradation status + dispose |
| `DegradationState` | Current mode (healthy/degraded), failure count, timestamps |

---

## Store Behavior

### SessionStore (write-through cache)

- `get(id)` → local Map first. Cache miss → Nexus `read`. Degraded + miss → NOT_FOUND
- `set(session)` → write local Map (sync). New sessions flush to Nexus immediately; updates coalesce
- `delete(id)` → delete local. Immediate Nexus delete (fire-and-forget)
- `entries()` → local Map only (sync — required by heartbeat sweep)
- Sessions track `ownerInstance` for CAS ownership transfer on resume

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
