# @koi/decision-index

Search-backed cross-session index for decision-ledger snapshots.

## Purpose

`@koi/decision-ledger` answers "what happened in this one session?".
`@koi/decision-index` answers "where have similar decisions appeared across sessions?".

The package depends only on `@koi/core`. Callers provide any `SearchBackend`,
including a Nexus-backed backend from `@koi/search-nexus`; this package never
imports that L2 peer directly.

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
});
```

## Trust Boundary

Indexed documents include `sessionId`, `sourceKind`, `source`, and stable
source IDs in metadata. Query helpers add session and source filters using the
L0 `SearchFilter` grammar. Malformed backend hits that omit decision metadata
are rejected rather than silently rendered as another source kind.
