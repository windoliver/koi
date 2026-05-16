# @koi/decision-graph

Materialized graph view of decision-ledger snapshots.

## Purpose

`@koi/decision-graph` turns a per-session ledger snapshot into graph artifacts:
session nodes, trajectory step nodes, audit-entry nodes, run-report nodes,
issue nodes, recommendation nodes, and typed edges between them.

The first implementation provides:

- `materializeDecisionGraph(snapshot)`
- `createInMemoryDecisionGraphStore()`
- `DecisionGraphStore` interface for durable stores
- neighbor and subgraph query APIs

The package depends only on `@koi/core` and uses structural snapshots rather
than importing `@koi/decision-ledger`.

## Runtime

`@koi/runtime` exposes `runtime.createDecisionGraph` when trajectory storage is
configured. The caller supplies a graph store, and runtime materializes from the
live ledger into that store.

```ts
const graph = runtime.createDecisionGraph?.({
  store,
  auditSink,
});

await graph?.materializeSession("session-123");
const neighbors = await graph?.getNeighbors({
  sessionId: "session-123",
  nodeId: "session:session-123",
  direction: "outgoing",
  hops: 1,
});
```

## Durable Store Boundary

The current package defines the durable `DecisionGraphStore` boundary and ships
an in-memory implementation. A Nexus or RecordStore adapter can implement the
same `upsertGraph`, `getGraph`, `getNeighbors`, and `getSubgraph` methods
without changing runtime wiring. The package deliberately fails closed on
integrity-leaky snapshots before materialization.
