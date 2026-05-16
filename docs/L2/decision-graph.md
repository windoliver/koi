# @koi/decision-graph

Materialized graph view of decision-ledger snapshots.

## Purpose

`@koi/decision-graph` turns a per-session ledger snapshot into graph artifacts:
session nodes, trajectory step nodes, audit-entry nodes, run-report nodes,
outcome nodes, issue nodes, recommendation nodes, and typed edges between them.

The first implementation provides:

- `materializeDecisionGraph(snapshot)`
- `createInMemoryDecisionGraphStore()`
- `createNexusVfsDecisionGraphStore()`
- `createNexusRecordStoreDecisionGraphStore()`
- `DecisionGraphStore` interface for durable stores
- neighbor and subgraph query APIs

The package depends only on `@koi/core` and uses structural snapshots rather
than importing `@koi/decision-ledger`.

## Graph Model

Nodes:

- `session`
- `trajectory_step`
- `audit_entry`
- `outcome`
- `run_report`
- `issue`
- `recommendation`

Edges:

- `contains`: session to trajectory, audit, and outcome nodes
- `precedes`: adjacent trajectory steps by `stepIndex`
- `corroborates`: audit entry to trajectory step only when a shared causal key is
  available (`toolName`/identifier)
- `produced`: trajectory step to outcome when
  `step.metadata.decisionCorrelationId` equals `outcome.correlationId`
- `summarizes`: run report to session
- `raises`: run report to issue
- `recommends`: run report to recommendation

The materializer never infers causality from timestamps alone. Wall-clock order
can guide display, but it is not a causal edge unless the snapshot includes a
shared key that survives across lanes.

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
  hops: 2,
});
```

## Durable Store Boundary

The package defines the durable `DecisionGraphStore` boundary and ships three
implementations:

- in-memory store for tests and process-local diagnostics
- Nexus VFS store that persists session graphs plus per-node/per-edge artifacts
- Nexus RecordStore HTTP adapter for graph-neighbor and subgraph queries

The RecordStore adapter calls the Koi-specific
`POST /api/v2/graph/decision-artifacts` write endpoint for `upsertGraph`. If a
Nexus deployment does not expose that endpoint yet, 404 and 405 responses return
an `EXTERNAL` error with `Nexus decision graph write endpoint unavailable`.

The package deliberately fails closed on integrity-leaky snapshots before
materialization.

## Traversal Bounds

Store queries require an explicit `sessionId`, and returned graph fragments stay
session-scoped. `getNeighbors()` defaults to one hop and accepts incoming,
outgoing, or both directions. `getSubgraph()` defaults to zero hops and expands
only through stored graph edges, so a session-to-outcome path requires two hops:
session `contains` trajectory step, trajectory step `produced` outcome.

## Tests

- Unit tests: `packages/lib/decision-graph/src/*.test.ts`
- Standalone golden: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`,
  `describe("Golden: @koi/decision-graph", ...)`
