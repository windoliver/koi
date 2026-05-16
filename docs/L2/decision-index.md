# @koi/decision-index

Search-backed cross-session index for decision-ledger snapshots.

## Purpose

`@koi/decision-ledger` answers "what happened in this one session?".
`@koi/decision-index` answers "where have similar decisions appeared across sessions?".

The package depends only on `@koi/core`. Callers provide any `SearchBackend`,
including a Nexus-backed backend from `@koi/search-nexus`; this package never
imports that L2 peer directly.

## Package Boundary

The package is an L2 adapter over the L0 `SearchBackend` contract:

- input: structural `DecisionLedgerSnapshot`
- write output: `IndexDocument<DecisionIndexDocumentData>[]`
- query input: `DecisionIndexQuery`
- query output: `DecisionIndexPage`

It does not import `@koi/decision-ledger` or `@koi/search-nexus`. Runtime and
hosts compose those packages when they want live ledger reads or durable Nexus
search.

## Contract

- `createDecisionIndex({ backend })`
- `indexSession(snapshot)`
- `queryDecisions(query)`

Snapshots are structural: they contain `sessionId`, `trajectorySteps`,
`auditEntries`, optional `runReport`, and `integrityLeakCounts`. The package
does not import `@koi/decision-ledger`.

Indexing fails closed when audit or report integrity leak counts are non-zero.
Re-indexing a session removes documents recorded by the previous session marker
before writing the new document set, so old report issues or recommendations do
not remain searchable after a later snapshot drops them.

`queryDecisions()` always excludes session-marker documents, then adds optional
`sessionId`, `sessionIds`, `sourceKinds`, and caller-provided `SearchFilter`
clauses with the L0 filter grammar. Backends that cannot express a filter should
return a `KoiError` rather than silently widening the query.

## Runtime

`@koi/runtime` exposes `runtime.createDecisionIndex` when trajectory storage is
configured. The runtime builds a live ledger snapshot and indexes it into the
caller-supplied backend.

```ts
const decisionIndex = runtime.createDecisionIndex?.({
  backend,
  auditSink,
});

await decisionIndex?.indexSession("session-123");
const results = await decisionIndex?.queryDecisions({
  text: "approval denied",
  sessionIds: ["session-123", "session-456"],
  filter: { kind: "eq", field: "decisionCorrelationId", value: "dcid-123" },
});
```

With Nexus:

```ts
import { createNexusSearch } from "@koi/search-nexus";

const backend = createNexusSearch({ transport, indexName: "decisions" });
const decisionIndex = runtime.createDecisionIndex?.({ backend });
```

## Trust Boundary

Indexed documents include bounded metadata only: `sessionId`, `sourceKind`,
`source`, stable source IDs, timestamps, step index, audit kind, report section,
and index time. The index stores content previews from trajectory, audit, and
run-report lanes, but it does not treat arbitrary backend metadata as trusted
decision metadata.

Malformed backend hits that omit decision metadata are rejected rather than
silently rendered as another source kind. Session markers are implementation
documents for idempotent re-indexing and are never returned as decision hits.

## Tests

- Unit tests: `packages/lib/decision-index/src/create-decision-index.test.ts`
- Standalone golden: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`,
  `describe("Golden: @koi/decision-index", ...)`
