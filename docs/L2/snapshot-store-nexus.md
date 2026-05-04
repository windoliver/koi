# @koi/snapshot-store-nexus

L2 storage adapter implementing `SnapshotChainStore<T>` from `@koi/core` over a Nexus JSON-RPC transport.

Same generic interface as `@koi/snapshot-store-sqlite` — drop-in replacement for distributed deployments where snapshot history must outlive a single host.

Tracks issue #1405.

---

## Why It Exists

`@koi/snapshot-store-sqlite` works for single-host agents but binds snapshot history to one disk. Distributed runtimes (multi-host workers, recovery on a different node) need persistence at the Nexus mount instead. This package preserves the L0 contract so callers (`@koi/checkpoint`, deterministic-replay) swap backend without code changes.

Ports the v1 implementation from `archive/v1/packages/fs/nexus-store/src/snapshots.ts` with two simplifications:

- Drops the v1 `createNexusClient(...)` wrapper — uses the v2 `NexusTransport.call(...)` directly
- Keeps the per-chain mutex (still needed; meta read-modify-write is non-atomic over RPC)

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  @koi/snapshot-store-nexus  (L2 adapter)               │
│                                                        │
│  types.ts          ← NexusSnapshotStoreConfig          │
│  paths.ts          ← path layout + segment validation  │
│  json-io.ts        ← read/write/delete/list/exists     │
│  nexus-store.ts    ← createSnapshotStoreNexus<T>       │
│  index.ts          ← public API                        │
└────────────────────────────────────────────────────────┘
Dependencies: @koi/core, @koi/hash, @koi/nexus-client
```

## Path layout

```
<basePath>/<chainId>/<nodeId>.json   — node payload (SnapshotNode<T>)
<basePath>/<chainId>/meta.json       — { headNodeId, nodeIds[] }
```

`basePath` defaults to `"snapshots"`. Chain ID and node ID are validated for path safety (no `/`, `..`, null bytes, or backslash).

## Concurrency

Operations that touch `meta.json` (`put`, `prune`) are serialized **per chain** via an in-memory mutex map. Two processes pointing at the same Nexus mount need a higher-level lock — same constraint as v1.

## Batch operations

Not exposed — `SnapshotChainStore<T>` has no batch method. Callers issuing many `put`s pay one round-trip per node. If batch becomes a bottleneck, lift a `putMany` into the L0 contract first.

## Connection-loss handling

Every method returns `Result<T, KoiError>`. Transport errors propagate as `EXTERNAL`-coded errors via `mapNexusError` from `@koi/nexus-client`. A `read` returning EXTERNAL or NOT_FOUND for a missing chain is treated as "empty chain" rather than failure.

## Wiring

`@koi/snapshot-store-nexus` is `koi.optional: true`. L3 (`@koi/runtime` or successor) selects between sqlite and nexus backends at assembly time based on config — no static `dependencies` link.
