# Issue 1469 Decision Traces Design

## Goal

Finish issue #1469 by turning the already-persisted per-session decision trace data into durable, queryable, cross-session decision intelligence.

The implementation keeps the shipped Phase 1 and Phase 2(a) work:

- Nexus-backed ATIF trajectory persistence in `@koi/runtime`.
- Per-session decision ledger projection in `@koi/decision-ledger`.

The remaining work is:

1. Harden the existing persistence/ledger surfaces with explicit restart and wiring tests where coverage is thin.
2. Add a cross-session decision index backed by the existing `SearchBackend` contract and usable with `@koi/search-nexus`.
3. Add graph materialization for decision artifacts, including a Nexus RecordStore HTTP adapter and a Nexus VFS durable adapter.

## Non-Goals

- Do not replace `@koi/decision-ledger`. It stays the per-session diagnostic reader.
- Do not make `@koi/decision-ledger` depend on `@koi/search-nexus`, `@koi/runtime`, or a graph package.
- Do not add vendor-specific Nexus RecordStore types to `@koi/core`.
- Do not build a UI in this issue. The delivered APIs are sufficient for a separate TUI-focused issue to consume.
- Do not require a live Nexus server for unit tests. Live integration tests stay optional and environment-gated.

## Current State

Phase 1 is implemented in `packages/meta/runtime/src/trajectory/nexus-delegate.ts`. `RuntimeConfig.trajectoryNexus` creates a Nexus-backed `TrajectoryDocumentStore` and shares its transport with the outcome store.

Phase 2(a) is implemented in `packages/lib/decision-ledger`. It reads a single session from:

- `TrajectoryDocumentStore`
- optional `AuditSink.query(sessionId)`
- optional `ReportStore`

It deliberately exposes separate trajectory and audit lanes instead of a merged wall-clock timeline.

`@koi/search-nexus` now exists in `packages/lib/search-nexus`, so the blocker called out in `docs/L2/decision-ledger.md` for Phase 2(b) has been removed.

## Architecture

### Package Boundaries

Add two L2 packages:

1. `@koi/decision-index`

   Read/write projection from decision artifacts into the L0 `SearchBackend` contract. It depends only on `@koi/core`.

2. `@koi/decision-graph`

   Read/write projection from decision artifacts into a small typed graph store contract local to the package. It depends only on `@koi/core`.

Runtime wires these packages as optional conveniences. The packages are usable directly in tests and custom assemblies.

Layering:

```text
L0  @koi/core
    SearchBackend, RichTrajectoryStep, AuditEntry, OutcomeReport, RunReport

L2  @koi/decision-ledger
    Per-session ledger reader

L2  @koi/decision-index
    Search document projection over ledgers and outcome reports

L2  @koi/decision-graph
    Typed decision graph projection and traversal

L2  @koi/search-nexus
    SearchBackend implementation

L3  @koi/runtime
    Optional factory wiring
```

No L2 package imports another L2 package except `@koi/runtime`, which is L3 and may wire them together.

### Data Flow

```text
event-trace -> TrajectoryDocumentStore -> decision-ledger -> decision-index -> SearchBackend
                                               |                |
AuditSink.query(sessionId) --------------------+                |
ReportStore -----------------------------------+                |
OutcomeStore.get(correlationId) --------------------------------+

decision-ledger -> decision-graph -> DecisionGraphStore
Outcome reports ------------------/
```

The indexer and graph materializer both consume a structural ledger snapshot rather than independently fetching every source. `@koi/decision-ledger.DecisionLedger` satisfies that snapshot structurally, but the new L2 packages do not import the `@koi/decision-ledger` L2 package.

## Phase 1: Persistence Hardening

### Scope

Keep existing Nexus trajectory storage design. Add coverage where it directly supports #1469 acceptance criteria:

- A trajectory written through `createAtifDocumentStore(..., createNexusAtifDelegate(...))` can be loaded through a fresh delegate instance backed by the same transport state.
- `createRuntime({ trajectoryNexus })` exposes a trajectory store and closes the shared Nexus transport on `dispose()`.

### Tests

Use existing unit tests where possible:

- Extend `packages/meta/runtime/src/trajectory/nexus-delegate.test.ts`.
- Avoid live Nexus requirements by using the existing fake transport pattern.
- Runtime wiring tests may require building workspace dependencies first; the implementation plan will run package-specific builds before runtime tests.

## Phase 2(b): Cross-Session Decision Index

### Package

Create `packages/lib/decision-index`.

Public API:

```ts
import type {
  AuditEntry,
  IndexDocument,
  KoiError,
  OutcomeReport,
  Result,
  RichTrajectoryStep,
  RunReport,
  SearchBackend,
  SearchPage,
  SearchQuery,
} from "@koi/core";

export type DecisionIndexDocumentKind =
  | "decision-step"
  | "audit-entry"
  | "run-report"
  | "outcome-report"
  | "session-summary";

export interface DecisionIndexRecord {
  readonly schemaVersion: 1;
  readonly kind: DecisionIndexDocumentKind;
  readonly sessionId: string;
  readonly id: string;
  readonly content: string;
  readonly timestampMs?: number | undefined;
  readonly decisionCorrelationId?: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DecisionIndexWriter {
  readonly indexLedger: (input: IndexLedgerInput) => Promise<Result<DecisionIndexWriteSummary, KoiError>>;
  readonly indexOutcome: (input: IndexOutcomeInput) => Promise<Result<DecisionIndexWriteSummary, KoiError>>;
  readonly removeSession: (sessionId: string) => Promise<Result<void, KoiError>>;
}

export interface DecisionIndexReader {
  readonly search: (query: DecisionSearchQuery) => Promise<Result<SearchPage<DecisionIndexRecord>, KoiError>>;
}

export interface DecisionIndex extends DecisionIndexWriter, DecisionIndexReader {}
```

The package accepts an injected `SearchBackend<DecisionIndexRecord>`.

### Projection Rules

`indexLedger()` produces deterministic document IDs:

- `session:{sessionId}:summary`
- `session:{sessionId}:step:{stepIndex}`
- `session:{sessionId}:audit:{index}`
- `session:{sessionId}:report:{reportIdOrCompletedAt}`

`indexOutcome()` produces:

- `outcome:{correlationId}`

Each document includes:

- Human-readable `content` for full-text search.
- Structured metadata for filters:
  - `kind`
  - `sessionId`
  - `timestampMs`
  - `stepIndex`
  - `stepKind`
  - `identifier`
  - `outcome`
  - `decisionCorrelationId`
  - `sourceStatus`
  - `integrityLeakAudit`
  - `integrityLeakReport`

The indexer only includes fields that are present and bounded. It does not copy arbitrary request/response payloads into metadata.

### Query Rules

`search()` maps domain filters into `SearchQuery.filter`.

Minimum query fields:

```ts
export interface DecisionSearchQuery {
  readonly text: string;
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly minScore?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly kind?: DecisionIndexDocumentKind | undefined;
  readonly decisionCorrelationId?: string | undefined;
}
```

This supports queries like:

- all discount decisions
- all decisions for a session
- all records linked to a `decisionCorrelationId`
- all negative outcomes

### Failure Semantics

- Empty `sessionId` is a validation error.
- Empty search text is allowed only when another structured filter is present.
- Search backend errors are returned unchanged.
- Indexing is idempotent because `SearchBackend.index()` replaces by document ID.
- Partial failures inherit `@koi/search-nexus` batch-failure context.

## Phase 3: Decision Graph

### Package

Create `packages/lib/decision-graph`.

Public graph model:

```ts
export type DecisionGraphNodeKind =
  | "session"
  | "trajectory-step"
  | "audit-entry"
  | "run-report"
  | "outcome-report"
  | "entity";

export type DecisionGraphEdgeKind =
  | "contains"
  | "approved"
  | "denied"
  | "reported-outcome"
  | "mentions-entity"
  | "correlates-with";

export interface DecisionGraphNode {
  readonly id: string;
  readonly kind: DecisionGraphNodeKind;
  readonly label: string;
  readonly sessionId?: string | undefined;
  readonly timestampMs?: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DecisionGraphEdge {
  readonly id: string;
  readonly kind: DecisionGraphEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DecisionGraphStore {
  readonly upsert: (
    nodes: readonly DecisionGraphNode[],
    edges: readonly DecisionGraphEdge[],
  ) => Promise<Result<DecisionGraphWriteSummary, KoiError>>;
  readonly neighbors: (query: DecisionGraphNeighborsQuery) => Promise<Result<DecisionSubgraph, KoiError>>;
  readonly path: (query: DecisionGraphPathQuery) => Promise<Result<DecisionSubgraph, KoiError>>;
}
```

Provide:

- `createInMemoryDecisionGraphStore()` for tests and local use.
- `createNexusDecisionGraphStore({ transport, basePath? })` for Nexus-backed persistence.

### Nexus Backing Strategy

Nexus already has RecordStore and graph storage concepts in `/Users/sophiawj/private/nexus`:

- `src/nexus/storage/record_store.py` exposes `RecordStoreABC` / `SQLAlchemyRecordStore`.
- `scripts/test_graph_store_e2e.py` exercises `nexus.bricks.search.graph_store.GraphStore`.
- `tests/e2e/server/test_graph_api_e2e.py` documents the server graph API shape:
  - `GET /api/v2/graph/entity/{id}`
  - `GET /api/v2/graph/search`
  - `GET /api/v2/graph/entity/{id}/neighbors`
  - `POST /api/v2/graph/subgraph`

Implement two Nexus adapters behind the same `DecisionGraphStore` contract:

1. `createNexusRecordStoreDecisionGraphStore({ fetch, url, apiKey?, zoneId? })`

   HTTP adapter for the upstream graph API. It writes through graph/record endpoints and reads through neighbors/subgraph endpoints. If an endpoint is missing, unsupported, or returns a version-incompatibility response, the adapter returns a typed `KoiError` and does not silently fall back.

2. `createNexusVfsDecisionGraphStore({ transport, basePath? })`

   VFS adapter used for local tests and deployments that have Nexus VFS but have not enabled graph API routes. It is a real durable graph store over Nexus files. It stores JSON records under:

```text
decision-graph/nodes/{encodedNodeId}.json
decision-graph/edges/{encodedEdgeId}.json
decision-graph/index/by-node/{encodedNodeId}.json
```

The package exposes `DecisionGraphStore` as the stable Koi-side boundary. Runtime can choose the HTTP RecordStore adapter when graph API config is present, or the VFS adapter when only `NexusTransport` is available.

### Materialization Rules

`materializeLedgerGraph({ ledger, outcomes? })` produces:

- one session node
- one node per trajectory step
- one node per audit entry
- one node for the run report when present
- one node per outcome report
- one entity node per extracted lightweight entity id

Edges:

- session `contains` step/audit/report/outcome nodes
- trajectory step `correlates-with` outcome when both share `decisionCorrelationId`
- audit entry `approved` or `denied` a trajectory step when a bounded correlation key is present
- any artifact `mentions-entity` for metadata fields named `entity`, `entityId`, `target`, or `decisionCorrelationId`

The materializer does not infer causal relationships from timestamps alone.

### Query Rules

`neighbors()` supports:

- `nodeId`
- `direction`: `"in" | "out" | "both"`
- `depth`: bounded to `1..3`
- `edgeKinds?: readonly DecisionGraphEdgeKind[]`

`path()` supports:

- `from`
- `to`
- `maxDepth`: bounded to `1..6`
- breadth-first traversal

## Runtime Wiring

Add optional factories to `RuntimeHandle`:

```ts
readonly createDecisionIndex?: (options: RuntimeDecisionIndexOptions) => DecisionIndex;
readonly createDecisionGraph?: (options: RuntimeDecisionGraphOptions) => DecisionGraphStore;
```

Runtime does not create Nexus search or graph backends unless configured. A host can inject:

- `SearchBackend<DecisionIndexRecord>` for `createDecisionIndex`.
- `DecisionGraphStore` or Nexus graph config for `createDecisionGraph`.

This avoids adding default live-network behavior to `createRuntime()`.

## Documentation

Update:

- `docs/L2/decision-ledger.md` to replace the obsolete `@koi/search-nexus` blocker note with the implemented Phase 2(b) index.
- Add `docs/L2/decision-index.md`.
- Add `docs/L2/decision-graph.md`.
- Update `docs/L3/runtime.md` with the optional factories.
- Update issue references in `docs/L2/event-trace.md` if Phase 1 hardening changes behavior.

## Test Strategy

### Unit Tests

`@koi/decision-index`:

- maps trajectory steps to deterministic search documents
- maps audit entries and run reports
- maps outcome reports
- builds structured filters for session, kind, and correlation id
- rejects empty unfiltered queries
- propagates search backend failures
- removal deletes all deterministic session document ids

`@koi/decision-graph`:

- materializes a session, steps, audit entries, report, and outcomes into nodes/edges
- does not infer causality from timestamps alone
- links outcome to step by `decisionCorrelationId`
- extracts bounded entity nodes
- in-memory `neighbors()` respects direction/depth/edge kind filters
- in-memory `path()` returns shortest path within `maxDepth`
- Nexus store persists nodes/edges and survives a fresh store instance sharing the same fake transport

### Runtime Tests

- `RuntimeHandle.createDecisionIndex` returns `undefined` or is absent unless a search backend is injected.
- Injected search backend is used to create a decision index.
- `RuntimeHandle.createDecisionGraph` can use an injected graph store.
- `RuntimeHandle.createDecisionGraph` can create a Nexus RecordStore HTTP graph adapter when graph API config is provided.
- `RuntimeHandle.createDecisionGraph` can create a Nexus VFS graph adapter when a shared Nexus transport is provided.

### Golden Tests

Add standalone goldens in `packages/meta/runtime/src/__tests__/golden-replay.test.ts`:

- decision-index indexes a fake ledger and can search by correlation id
- decision-graph materializes a fake ledger and traverses session-to-outcome path

No live LLM and no live Nexus in these goldens.

## Rollout

The branch should land in commits by phase:

1. Spec and plan.
2. Phase 1 hardening tests.
3. `@koi/decision-index`.
4. Runtime decision-index wiring and docs.
5. `@koi/decision-graph`.
6. Runtime decision-graph wiring and docs.

Each phase is independently testable and leaves the repo usable.

## Risks

- The full issue is large. Keeping `decision-index` and `decision-graph` separate prevents one subsystem from blocking the other.
- Nexus graph APIs may differ across deployments. The HTTP RecordStore adapter fails closed on unsupported routes; the VFS adapter provides durable graph behavior for deployments that expose Nexus VFS but not graph endpoints.
- Cross-session query results can expose sensitive content. The indexer copies bounded summaries and explicit metadata only; raw request/response bodies remain in trajectory storage.
- Existing workspace tests require built workspace packages because package exports point at `dist`. The implementation plan will build dependencies before running package tests.

## Acceptance Mapping

- `TrajectoryDocumentStore` Nexus adapter implemented: already done; hardening tests remain.
- Configurable persistence in `event-trace`: already done through runtime `trajectoryNexus`; hardening tests remain.
- Trajectory survives process restart: covered by fresh delegate/store tests.
- Decision ledger projection available per session: already done; remains an input to index and graph.
- Cross-session decision index queryable via search: implemented by `@koi/decision-index`.
- Nexus RecordStore adapter for graph data: implemented by `createNexusRecordStoreDecisionGraphStore` against Nexus graph API routes, with a separate VFS durable adapter for VFS-only deployments.
- Context graph materialization from decision artifacts: implemented by `@koi/decision-graph`.
