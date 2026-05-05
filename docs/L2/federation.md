# @koi/federation — Multi-Zone Agent Coordination & Edge Sync

`@koi/federation` is an L2 package that enables agents in different zones to
discover each other, delegate tasks cross-zone, and sync state. Edge deployments
sync back to cloud when connected via event-sourced replication keyed on a
monotonic per-zone sequence number.

> **Phase 3 baseline (this doc):** zone registry, fixed-poll sync engine,
> sequence-cursor deduplication, and cross-zone tool routing. Vector clocks,
> LWW conflict resolution, adaptive polling, snapshot truncation, and clock
> pruning are **deferred to #1410 (Phase 4e)**.

---

## Why it exists

The zone concept already existed in 4 places (`ForgeScope`, `ToolCallPayload.zone`,
`NexusRegistryConfig.zoneId`, `COMPONENT_PRIORITY.ZONE_FORGED`) but with raw
strings and no enforcement. Federation formalizes zones as a first-class concept
with typed identity, registry, sync protocol, and cross-zone delegation.

```
Before                              After
──────────────────────────────      ────────────────────────────────────
zone: string (raw, untyped)         ZoneId (branded, typed)
no zone registry                    ZoneRegistry (L0 interface)
no cross-zone communication         FederationMiddleware (wrapToolCall)
no state sync                       SyncEngine (sequence-cursor delta poll)
zone scope = passthrough             zone scope = tag-based enforcement
```

---

## Architecture

### Layer position

```
L0  @koi/core                ─ ZoneId, ZoneDescriptor, ZoneRegistry,
                                ZoneEvent, ZoneStatus, ZoneFilter,
                                zoneId(), ZONE_REGISTRY token
L0u @koi/nexus-client        ─ NexusClient (JSON-RPC transport)
L2  @koi/federation          ─ this package
L2  @koi/forge               ─ consumer (zone scope enforcement)
```

`@koi/federation` imports only from `@koi/core` (L0) and `@koi/nexus-client`
(L0u). It never touches `@koi/engine` (L1) and has zero peer L2 dependencies.

### Internal module map

```
index.ts                  ← public re-exports
│
├── types.ts              ← SyncCursor, FederationSyncEvent,
│                            FederationConfig, DEFAULT_FEDERATION_CONFIG
│
├── config.ts             ← validateFederationConfig()
│
├── sync-protocol.ts      ← SyncClient interface, createNexusSyncClient(),
│                            advanceCursor(), deduplicateEvents()
│
├── sync-engine.ts        ← createSyncEngine() — fixed-interval polling,
│                            health monitor, graceful disconnect
│
├── zone-registry-nexus.ts ← createZoneRegistryNexus() — Nexus-backed
│                             ZoneRegistry with in-memory projection
│
└── federation-middleware.ts ← createFederationMiddleware() — cross-zone
                               tool call routing via wrapToolCall
```

---

## How it works

### Federation topology: Nexus-Centric Hub

```
           ┌──────────┐
           │  Nexus    │
           │  Server   │
           └──┬──┬──┬──┘
              │  │  │
     ┌────────┘  │  └────────┐
     │           │           │
  ┌──▼──┐    ┌──▼──┐    ┌──▼──┐
  │Zone A│    │Zone B│    │Zone C│
  │agents│    │agents│    │agents│
  └──────┘    └──────┘    └──────┘
```

Each zone registers itself with a Nexus server. Zones sync events through
Nexus and delegate tool calls via JSON-RPC.

### Zone lifecycle

```
  active ──── draining ──── offline
    │                          │
 normal                   partitioned
 operation                or shutting
                          down
```

| Status | Meaning |
|--------|---------|
| `active` | Zone is operational and accepting work |
| `draining` | Zone is finishing existing work, not accepting new |
| `offline` | Zone is unreachable or shut down |

### Cross-zone tool call flow

```
Agent in Zone B → bash("ls") with targetZoneId: "zone-a"
         │
         ▼
  [FederationMiddleware]
   wrapToolCall checks targetZoneId
         │
         ├── absent?      → pass through (local execution)
         ├── local zone?  → pass through (local execution)
         ├── unknown zone? → EXTERNAL error
         │
         └── known remote zone?
              │
              ▼
         remoteClient.rpc("federation.zone_execute", {
           toolId: "bash",
           input: { command: "ls" },
           targetZoneId: "zone-a"
         })
              │
              ▼
         ToolResponse from Zone A
```

### Event-sourced sync

```
Zone A publishes events     Zone B syncs
────────────────────────    ───────────────────
event { seq: 1 }
event { seq: 2 }               ← fetchDelta(cursor.lastSequence)
event { seq: 3 }               ← deduplicateEvents (seq > lastSequence)
                                ← advanceCursor (lastSequence = max)
                                ← notifyHandlers
```

Each remote-zone cursor tracks a **monotonic `lastSequence`**; sync polls at a
**fixed interval** (`pollIntervalMs`).

### Health monitor

The sync engine tracks consecutive fetch failures per remote zone. After
`offlineAfterFailures` consecutive errors a zone is marked **offline** locally;
a subsequent successful fetch flips it back to **active**. Disposing the engine
sends a `federation.zone_disconnect` notification (best-effort, errors swallowed)
so the Nexus hub can mark the zone `draining` immediately rather than waiting
for the heartbeat timeout.

### Deferred to #1410 (Phase 4e)

The following sub-systems are **out of scope** for this Phase 3 baseline:

- **Vector clocks** — replaced by monotonic `SyncCursor.lastSequence`.
- **LWW conflict resolution** — Phase 3 events are append-only; conflicts are
  not yet observable.
- **Adaptive polling** — fixed `pollIntervalMs` only.
- **Snapshot + truncation** — event log retained in full for the session.
- **Vector-clock pruning** — N/A without vector clocks.

---

## The `ZoneRegistry` interface (L0)

Defined in `@koi/core/zone`:

```typescript
interface ZoneRegistry extends AsyncDisposable {
  readonly register: (descriptor: ZoneDescriptor) =>
    ZoneDescriptor | Promise<ZoneDescriptor>;
  readonly deregister: (zoneId: ZoneId) =>
    boolean | Promise<boolean>;
  readonly lookup: (zoneId: ZoneId) =>
    ZoneDescriptor | undefined | Promise<ZoneDescriptor | undefined>;
  readonly list: (filter?: ZoneFilter) =>
    readonly ZoneDescriptor[] | Promise<readonly ZoneDescriptor[]>;
  readonly watch: (listener: (event: ZoneEvent) => void) => () => void;
}
```

Return type is `T | Promise<T>` — in-memory implementations are sync,
Nexus-backed implementations are async.

### `ZoneDescriptor`

```typescript
interface ZoneDescriptor {
  readonly zoneId: ZoneId;
  readonly displayName: string;
  readonly status: ZoneStatus;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly registeredAt: number;
}
```

### `ZoneEvent`

```typescript
type ZoneEvent =
  | { kind: "zone_registered";      descriptor: ZoneDescriptor }
  | { kind: "zone_deregistered";    zoneId: ZoneId }
  | { kind: "zone_updated";         descriptor: ZoneDescriptor }
  | { kind: "zone_status_changed";  zoneId: ZoneId; from: ZoneStatus; to: ZoneStatus };
```

---

## Built-in components

### `createZoneRegistryNexus(config)`

Nexus-backed `ZoneRegistry` implementation. Uses `NexusClient` JSON-RPC for
persistence, maintains an in-memory projection for fast reads.

```typescript
import { createZoneRegistryNexus } from "@koi/federation";

const registry = createZoneRegistryNexus({ client: nexusClient });

await registry.register({
  zoneId: zoneId("us-east-1"),
  displayName: "US East 1",
  status: "active",
  registeredAt: Date.now(),
});

const zones = await registry.list({ status: "active" });
```

RPC methods called: `federation.zone_register`, `federation.zone_deregister`.

### `createSyncEngine(config)`

Event-sourced sync engine with **fixed-interval polling** and a health monitor.
(Adaptive polling and snapshot truncation are deferred to Phase 4e — see #1410.)

```typescript
import { createSyncEngine } from "@koi/federation";

const engine = createSyncEngine({
  localZoneId: zoneId("us-east-1"),
  remoteClients: new Map([
    ["us-west-2", syncClient],
  ]),
  pollIntervalMs: 5000,
  offlineAfterFailures: 3,
});

// Manual sync
await engine.sync();

// Subscribe to incoming events
engine.onEvent((event) => {
  console.log(`Received: ${event.kind} from ${event.originZoneId}`);
});

// Dispose when done
await engine[Symbol.asyncDispose]();
```

### `createFederationMiddleware(config)`

`KoiMiddleware` that transparently routes cross-zone tool calls.

```typescript
import { createFederationMiddleware } from "@koi/federation";

const mw = createFederationMiddleware({
  localZoneId: zoneId("us-east-1"),
  remoteClients: new Map([
    ["us-west-2", nexusClientForWest],
  ]),
  onDelegated: (targetZone, request) => {
    console.log(`Delegated ${request.toolId} to ${targetZone}`);
  },
});

// Wire into agent middleware chain
// middleware: [mw, ...]
```

**Routing rules:**

| `ctx.metadata.targetZoneId` | Behavior |
|-----------------------------|----------|
| absent | Pass through (local) |
| matches `localZoneId` | Pass through (local) |
| known remote zone | Route via `rpc("federation.zone_execute")` |
| unknown zone | Return `EXTERNAL` error |

---

## Sync cursor

Phase 3 uses a **monotonic per-zone sequence cursor**. Vector-clock based causal
ordering is deferred to #1410.

```typescript
interface SyncCursor {
  readonly zoneId: ZoneId;
  readonly lastSequence: number;
  readonly lastSyncAt: number;
}
```

`advanceCursor(cursor, events)` updates `lastSequence` to the max sequence
across the batch. `deduplicateEvents(events, cursor)` keeps only events with
`sequence > cursor.lastSequence`.

---

## Configuration

```typescript
import { validateFederationConfig } from "@koi/federation";

const result = validateFederationConfig({
  localZoneId: zoneId("us-east-1"),
  remoteZones: [zoneId("us-west-2"), zoneId("eu-west-1")],
  // All optional — defaults applied:
  pollIntervalMs: 5000,           // default: 5000
  offlineAfterFailures: 3,        // default: 3
});

if (!result.ok) {
  console.error(result.error.message);
}
```

---

## Forge zone enforcement

`@koi/forge` uses zone tags for scope enforcement:

```
Brick scope    zoneId provided?    Tag check
──────────     ────────────────    ─────────────────────
global         any                 always visible
zone           no                  visible (backward compat)
zone           yes                 brick must have "zone:<zoneId>" tag
agent          any                 creator match only
```

```typescript
import { isVisibleToAgent, filterByAgentScope } from "@koi/forge";

// Without zoneId — backward compatible
isVisibleToAgent(brick, "agent-1");

// With zoneId — zone tag enforcement
isVisibleToAgent(brick, "agent-1", "us-east-1");
// → true only if brick.tags.includes("zone:us-east-1")
```

---

## Edge sync scenarios

| Scenario | Behavior |
|----------|----------|
| Partition recovery | Zone catches up on all missed events after reconnect |
| Concurrent writes | Phase 3 baseline: append-only; LWW deferred to #1410 |
| Duplicate delivery | `deduplicateEvents` filters by `sequence > cursor.lastSequence` |
| Out-of-order events | Only events with `sequence > cursor.lastSequence` processed |
| Zone joins mid-sync | New zone starts from sequence 0, catches up fully |
| Empty zone | Empty delta, cursor stays at 0 |
| Persistent fetch failure | After `offlineAfterFailures` consecutive errors, zone marked offline locally |

---

## API reference

### Factory functions

| Function | Returns | Description |
|----------|---------|-------------|
| `createZoneRegistryNexus(config)` | `ZoneRegistry` | Nexus-backed zone registry |
| `createSyncEngine(config)` | `SyncEngineHandle` | Adaptive polling sync engine |
| `createNexusSyncClient(config)` | `SyncClient` | Nexus-backed sync client |
| `createFederationMiddleware(config)` | `KoiMiddleware` | Cross-zone tool call routing |
| `validateFederationConfig(config)` | `Result<FederationConfig>` | Config validation with defaults |

### Pure functions

| Function | Description |
|----------|-------------|
| `advanceCursor(cursor, events)` | Update cursor `lastSequence` to max across batch |
| `deduplicateEvents(events, cursor)` | Filter already-seen events (seq > lastSequence) |

> Vector-clock helpers (`incrementClock`, `mergeClock`, `compareClock`,
> `isAfterCursor`, `pruneClock`) and `resolveConflict` are **deferred to #1410
> (Phase 4e)**.

### Exported constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_FEDERATION_CONFIG` | `Partial<FederationConfig>` | Sensible defaults for all config fields |

---

## Layer compliance

```
L0  @koi/core ─────────────────────────────────────────────────┐
    ZoneId, ZoneDescriptor, ZoneRegistry, ZoneEvent,            │
    ZoneStatus, ZoneFilter, zoneId(), ZONE_REGISTRY             │
                                                                │
L0u @koi/nexus-client ──────────────────────────────────────────┤
    NexusClient (JSON-RPC transport)                            │
                                                                │
L2  @koi/federation ◄───────────────────────────────────────────┘
    imports from L0 and L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies beyond workspace packages
```

---

## Related packages

| Package | Relationship |
|---------|-------------|
| `@koi/core` | Defines `ZoneId`, `ZoneRegistry`, `ZoneEvent` (L0 types) |
| `@koi/nexus-client` | JSON-RPC transport for Nexus server communication |
| `@koi/forge` | Consumer — zone scope enforcement via `isVisibleToAgent` |
| `@koi/gateway` | Prerequisite — delivery semantics (Issue #3) |
