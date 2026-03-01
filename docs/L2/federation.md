# @koi/federation — Multi-Zone Agent Coordination & Edge Sync

`@koi/federation` is an L2 package that enables agents in different zones to
discover each other, delegate tasks cross-zone, and sync state. Edge deployments
sync back to cloud when connected via event-sourced replication with vector
clocks.

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
no state sync                       SyncEngine (event-sourced, vector clocks)
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
├── types.ts              ← VectorClock, SyncCursor, FederationSyncEvent,
│                            FederationConfig, DEFAULT_FEDERATION_CONFIG
│
├── vector-clock.ts       ← incrementClock(), mergeClock(), compareClock(),
│                            isAfterCursor(), pruneClock()
│
├── config.ts             ← validateFederationConfig()
│
├── sync-protocol.ts      ← SyncClient interface, createNexusSyncClient(),
│                            resolveConflict(), advanceCursor(),
│                            deduplicateEvents()
│
├── sync-engine.ts        ← createSyncEngine() — adaptive polling,
│                            snapshot truncation, clock pruning
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
event { seq: 1, vc: {a:1} }
event { seq: 2, vc: {a:2} }    ← fetchDelta(cursor)
event { seq: 3, vc: {a:3} }    ← deduplicateEvents
                                ← advanceCursor
                                ← notifyHandlers
```

Each zone maintains a **vector clock** for causal ordering. The sync engine
uses **adaptive polling**:

```
Events found?    Poll interval change
─────────────    ────────────────────
YES              halve interval (floor = minPollIntervalMs)
NO               double interval (cap = maxPollIntervalMs)
```

### Conflict resolution: Last-Writer-Wins (LWW)

When two zones concurrently modify the same resource:

```
Zone A: event { emittedAt: 1000 }
Zone B: event { emittedAt: 2000 }

resolveConflict(A, B) → B wins (later timestamp)
```

Tie-breaker: lexicographically higher zone ID wins (deterministic).

### Event log bounding

When the event log exceeds `snapshotThreshold`, it is truncated to
`threshold / 2`, keeping the newest events. This prevents unbounded memory
growth in long-running deployments.

### Vector clock pruning

Zones inactive longer than `clockPruneAfterMs` are removed from vector
clocks to prevent clock size from growing unboundedly as zones join and leave.

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

Event-sourced sync engine with adaptive polling, snapshot truncation, and
vector clock pruning.

```typescript
import { createSyncEngine } from "@koi/federation";

const engine = createSyncEngine({
  localZoneId: zoneId("us-east-1"),
  remoteClients: new Map([
    ["us-west-2", syncClient],
  ]),
  pollIntervalMs: 5000,
  minPollIntervalMs: 1000,
  maxPollIntervalMs: 30000,
  snapshotThreshold: 1000,
  clockPruneAfterMs: 86_400_000,
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

## Vector clock operations

Pure functions, no I/O:

```typescript
import {
  incrementClock,
  mergeClock,
  compareClock,
  pruneClock,
} from "@koi/federation";

// Increment local zone's clock component
const clock = incrementClock({ "zone-a": 3 }, "zone-a");
// → { "zone-a": 4 }

// Merge two clocks (component-wise max)
const merged = mergeClock(
  { "zone-a": 3, "zone-b": 1 },
  { "zone-a": 1, "zone-b": 5 },
);
// → { "zone-a": 3, "zone-b": 5 }

// Compare causal ordering
compareClock(a, b);
// → "before" | "after" | "concurrent" | "equal"

// Prune idle zones
const pruned = pruneClock(clock, lastActiveTimes, cutoffTimestamp);
```

---

## Configuration

```typescript
import { validateFederationConfig } from "@koi/federation";

const result = validateFederationConfig({
  localZoneId: zoneId("us-east-1"),
  remoteZones: [zoneId("us-west-2"), zoneId("eu-west-1")],
  // All optional — defaults applied:
  pollIntervalMs: 5000,      // default: 5000
  minPollIntervalMs: 1000,   // default: 1000
  maxPollIntervalMs: 30000,  // default: 30000
  snapshotThreshold: 1000,   // default: 1000
  clockPruneAfterMs: 86400000, // default: 24h
  conflictResolution: "lww", // default: "lww"
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
| Concurrent writes | LWW picks higher `emittedAt`; tie-breaks by zone ID |
| Duplicate delivery | `deduplicateEvents` filters by `sequence > cursor.lastSequence` |
| Large replay | Event log truncated to `threshold/2` when exceeding `snapshotThreshold` |
| Out-of-order events | Only events with `sequence > cursor.lastSequence` processed |
| Zone joins mid-sync | New zone starts from sequence 0, catches up fully |
| Empty zone | Empty delta, cursor stays at 0 |

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
| `incrementClock(clock, zoneId)` | Increment zone's clock component |
| `mergeClock(a, b)` | Component-wise maximum |
| `compareClock(a, b)` | `"before" \| "after" \| "concurrent" \| "equal"` |
| `isAfterCursor(event, cursor, zoneId)` | Check if event is newer than cursor |
| `pruneClock(clock, lastActiveTimes, cutoffAt)` | Remove idle zones |
| `advanceCursor(cursor, events)` | Update cursor after processing events |
| `deduplicateEvents(events, cursor)` | Filter already-seen events |
| `resolveConflict(local, remote)` | LWW conflict resolution |

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
