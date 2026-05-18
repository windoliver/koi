# @koi/federation — Multi-Zone Agent Coordination & Edge Sync

`@koi/federation` is an L2 package that enables agents in different zones to
discover each other, delegate tasks cross-zone, and sync state. Edge deployments
sync back to cloud when connected via event-sourced replication keyed on a
monotonic per-zone sequence number.

> **Current contract:** zone registry, fixed-poll sync engine, sequence-cursor
> deduplication, optional vector-clock metadata, concurrent shared-resource
> conflict reports (`lww`, `merge`, `manual`), explicit and zone-router driven
> cross-zone tool routing, plus in-memory Raft-style consensus primitives for
> federation critical state. Adaptive polling and durable snapshot/truncation
> policy remain future work.

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
├── types.ts              ← SyncCursor, FederationSyncEvent, VectorClock,
│                            ConflictReport, FederationConfig,
│                            DEFAULT_FEDERATION_CONFIG
│
├── config.ts             ← validateFederationConfig()
│
├── sync-protocol.ts      ← SyncClient interface, createNexusSyncClient(),
│                            advanceCursor(), deduplicateEvents(),
│                            vector-clock cursor merge
│
├── sync-engine.ts        ← createSyncEngine() — fixed-interval polling,
│                            conflict reports, health monitor,
│                            graceful disconnect
│
├── vector-clock.ts       ← increment/merge/compare/prune clocks,
│                            detect and resolve event conflicts
│
├── zone-registry-nexus.ts ← createZoneRegistryNexus() — Nexus-backed
│                             ZoneRegistry with in-memory projection
│
├── zone-router.ts        ← createZoneRouter(), pickHealthyZone() —
│                            health-aware remote-zone selection
│
├── raft-consensus.ts     ← createInMemoryRaftCluster() — deterministic
│                            leader election, quorum append, partition,
│                            split-brain detection, and healing
│
└── federation-middleware.ts ← createFederationMiddleware() — explicit or
                               router-selected cross-zone tool routing
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

When the middleware is constructed with `zoneRouter`, it can also select a
remote zone when `ctx.metadata.targetZoneId` is absent. This keeps explicit
operator or gateway routing authoritative: only `undefined` triggers
auto-routing. Present-but-invalid metadata, such as a numeric `targetZoneId`,
falls through locally rather than being silently replaced by a router choice.

### Event-sourced sync

```
Zone A publishes events     Zone B syncs
────────────────────────    ───────────────────
event { seq: 1 }
event { seq: 2 }               ← fetchDelta(cursor.lastSequence)
event { seq: 3 }               ← deduplicateEvents (seq > lastSequence)
                                ← advanceCursor (highest contiguous prefix)
                                ← notifyHandlers
```

Each remote-zone cursor tracks a **monotonic `lastSequence`** and may also carry
a merged **`vectorClock`**. Sequence numbers remain the delivery and
deduplication authority. Vector clocks describe causal ordering across zones and
are merged into the cursor as accepted events arrive. Sync polls at a **fixed
interval** (`pollIntervalMs`).

### Concurrent conflict reporting

Events may include `vectorClock` metadata. When two events from different zones
declare the same shared resource (`data.resourceKey`) and their vector clocks are
concurrent, the sync engine records a `ConflictReport` and invokes any
`onConflict` subscribers. The `conflictResolution` strategy controls the local
resolution result:

| Strategy | Behavior |
|----------|----------|
| `lww` | Default. Pick the later `timestamp`; tie-break by `originZoneId`. |
| `merge` | Shallow-merge `data` and merge both vector clocks. |
| `manual` | Report the conflict without choosing a winner. |

`getConflictReports()` returns a snapshot of observed reports for UI surfaces
and diagnostics. Conflict handler errors are swallowed so advisory reporting
cannot break sync progress.

### Health monitor

The sync engine tracks consecutive fetch failures per remote zone. After
`offlineAfterFailures` consecutive errors a zone is marked **offline** locally;
a subsequent successful fetch flips it back to **active**. Disposing the engine
sends a `federation.zone_disconnect` notification (best-effort, errors swallowed)
so the Nexus hub can mark the zone `draining` immediately rather than waiting
for the heartbeat timeout.

### Deferred follow-ups

The following sub-systems are still outside the current package contract:

- **Adaptive polling** — fixed `pollIntervalMs` only.
- **Durable snapshot + truncation policy** — event log retention remains an
  in-process engine concern.
- **Automated vector-clock retention policy** — `pruneVectorClock` is available
  as a helper, but the sync engine does not yet run a durable pruning policy.

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
  conflictResolution: "lww",
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

`KoiMiddleware` that transparently routes cross-zone tool calls. Explicit
`ctx.metadata.targetZoneId` still wins. If it is absent and `zoneRouter` is
configured, the middleware asks the router for the healthiest target zone.

```typescript
import { createFederationMiddleware, createZoneRouter } from "@koi/federation";

const zoneRouter = createZoneRouter({
  healthMonitor,
});

const mw = createFederationMiddleware({
  localZoneId: zoneId("us-east-1"),
  remoteClients: new Map([
    ["us-west-2", nexusClientForWest],
  ]),
  zoneRouter,
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
| absent + no `zoneRouter` | Pass through (local) |
| absent + `zoneRouter` selects remote | Route via `rpc("federation.zone_execute")` |
| present but not a string | Pass through (local) |
| matches `localZoneId` | Pass through (local) |
| known remote zone | Route via `rpc("federation.zone_execute")` |
| unknown zone | Return `EXTERNAL` error |

---

### `createZoneRouter(config)` and `pickHealthyZone(candidates)`

Zone routing is intentionally small and deterministic. A
`StaticZoneHealthMonitor` snapshot lists remote candidates with health, latency,
and optional load. `pickHealthyZone()` filters to `active` zones, then chooses by
lowest latency, lowest load, and finally zone id for stable tie-breaking.

```typescript
import { createStaticZoneHealthMonitor, createZoneRouter } from "@koi/federation";

const healthMonitor = createStaticZoneHealthMonitor([
  { zoneId: "us-west-2", status: "active", latencyMs: 35, load: 0.6 },
  { zoneId: "eu-west-1", status: "offline", latencyMs: 20, load: 0.1 },
]);

const router = createZoneRouter({ healthMonitor });
const target = router.selectZone({ toolId: "bash", input: { command: "uptime" } });
// → { zoneId: "us-west-2", ... }
```

Routers return `undefined` when every known zone is unhealthy, allowing the
middleware to keep the call local instead of fabricating a remote target.

### `createInMemoryRaftCluster(config)`

The Raft helper is a deterministic in-memory consensus model for federation
critical state. It is not a durable transport implementation; it is the package
contract and replacement point for production backends that need leader
election, quorum replication, partition behavior, split-brain detection, and
healing semantics.

```typescript
import { createInMemoryRaftCluster } from "@koi/federation";

const cluster = createInMemoryRaftCluster({
  nodeIds: ["zone-a", "zone-b", "zone-c"],
});

const leader = cluster.electLeader();
const append = cluster.append({
  kind: "zone_descriptor_put",
  key: "zone-a",
  value: { status: "active" },
});
```

`append()` requires a quorum and fails closed while split-brain is detected.
After partitions heal, `healPartition()` converges nodes onto the longest
committed log and elects a single leader.

## Sync cursor

Federation sync uses a **monotonic per-zone sequence cursor** with optional
vector-clock causal metadata.

```typescript
interface SyncCursor {
  readonly zoneId: ZoneId;
  readonly lastSequence: number;
  readonly lastSyncAt: number;
  readonly vectorClock?: VectorClock;
}
```

`advanceCursor(cursor, events)` advances `lastSequence` only through the
highest **contiguous** prefix starting at `cursor.lastSequence + 1`. Gaps
or out-of-order batches are a protocol fault — the cursor stays put and
the engine counts a failure. `deduplicateEvents(events, cursor)` keeps
only events with `sequence > cursor.lastSequence`. When accepted events contain
`vectorClock`, `advanceCursor` merges those components into the returned cursor.
Vector-clock components must be non-negative integers.

This is **federation wire-protocol v1** (`FEDERATION_PROTOCOL_VERSION = 1`),
established by this Phase 3 baseline. All RPC calls
(`sync_fetch_delta`, `sync_publish`, `zone_execute`, `zone_cancel`)
include a `protocolVersion` field on the wire. Receiver-side validation
(rejecting mismatched versions) is the responsibility of the federation
server handler (out of scope for this client PR — handler is a follow-up
under #1410). Until then, sending the field provides forward-compatibility:
when v2 lands, both sides can negotiate without an incompatible cutover.

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
  conflictResolution: "lww",      // default: "lww"
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
| Concurrent writes | Same-resource concurrent vector clocks emit `ConflictReport`; `lww` is default |
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
| `createSyncEngine(config)` | `SyncEngineHandle` | Fixed-interval sync engine with conflict reporting |
| `createNexusSyncClient(config)` | `SyncClient` | Nexus-backed sync client |
| `createFederationMiddleware(config)` | `KoiMiddleware` | Cross-zone tool call routing |
| `createStaticZoneHealthMonitor(candidates)` | `StaticZoneHealthMonitor` | Immutable health snapshot for routing |
| `createZoneRouter(config)` | `ZoneRouter` | Health-aware remote-zone selector |
| `createInMemoryRaftCluster(config)` | `InMemoryRaftCluster` | Deterministic Raft-style consensus cluster |
| `validateFederationConfig(config)` | `Result<FederationConfig>` | Config validation with defaults |

### Pure functions

| Function | Description |
|----------|-------------|
| `advanceCursor(cursor, events)` | Advance cursor through highest contiguous prefix (gaps stop progression) |
| `deduplicateEvents(events, cursor)` | Filter already-seen events (seq > lastSequence) |
| `pickHealthyZone(candidates)` | Select the active zone with best latency/load ordering |
| `incrementVectorClock(clock, zoneId)` | Return a clock with the zone component incremented |
| `mergeVectorClock(left, right)` | Return the component-wise maximum clock |
| `compareVectorClock(left, right)` | Classify clocks as before, after, equal, or concurrent |
| `pruneVectorClock(clock, activeZones)` | Drop components for zones no longer active |
| `getConflictResourceKey(event)` | Extract the shared conflict key from event data |
| `detectEventConflict(left, right)` | Detect same-resource concurrent event writes |
| `resolveEventConflict(report, strategy)` | Produce `lww`, `merge`, or `manual` conflict results |

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
