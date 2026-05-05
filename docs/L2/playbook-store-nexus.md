# @koi/playbook-store-nexus

L2 storage adapter implementing the four ACE store contracts from `@koi/ace-types` over Nexus JSON-RPC:

- `PlaybookStore`
- `StructuredPlaybookStore`
- `TrajectoryStore`
- `PlaybookProposalStore`

Same interfaces as `@koi/playbook-store-sqlite` — drop-in for distributed deployments.

Tracks issue #1405.

---

## Why It Exists

ACE's self-improvement loop persists playbooks, structured playbooks, trajectories, and proposals across sessions. Sqlite works on a single host. When agents run on different machines but share a Nexus mount, they need a backend that publishes learning to every peer. This package provides exactly that, behind the same contracts.

Ports `archive/v1/packages/fs/nexus-store/src/ace.ts` to v2's split-package layout (one factory per substore) and replaces the v1 `createNexusClient(...)` wrapper with the v2 `NexusTransport.call(...)` surface.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ @koi/playbook-store-nexus (L2)                          │
│                                                         │
│ types.ts        ← NexusPlaybookStoreConfig              │
│ json-io.ts      ← read/write/delete/listChildren        │
│ playbook.ts     ← createNexusPlaybookStore              │
│ structured.ts   ← createNexusStructuredPlaybookStore    │
│ trajectory.ts   ← createNexusTrajectoryStore            │
│ proposal.ts     ← createNexusPlaybookProposalStore      │
│ store.ts        ← createPlaybookStoreNexus (composite)  │
│ index.ts        ← public API                            │
└─────────────────────────────────────────────────────────┘
Dependencies: @koi/ace-types, @koi/core, @koi/nexus-client
```

## Path layout

```
<basePath>/playbooks/<id>.json
<basePath>/structured/<id>.json
<basePath>/trajectories/<sessionId>/<batchId>.json  (per-batch; one file per append call)
<basePath>/proposals/<proposalId>.json              (source of truth; playbookId is a field)
<basePath>/evaluations/<proposalId>.json
```

`listProposals(playbookId)` is O(total proposals) — it enumerates ALL `<base>/proposals/*.json`
and filters by `proposal.playbookId`. No separate per-playbook index is maintained.
Acceptable for ACE: list ops are user-driven, not hot-path.

`basePath` defaults to `"ace"`. IDs are sanitized — colons in session IDs become `_3A` so Nexus list/glob can index them.

### Trajectory batch layout

`TrajectoryStore.append` writes one immutable batch file per call:

```
<basePath>/trajectories/<encodedSessionId>/<timestamp>-<seq>-<randomSlice>.json
```

`batchId = ${Date.now()}-${seqPadded6}-${uuid.slice(0,8)}`

- **Cross-instance correctness**: two store instances appending concurrently write to *different* filenames (random suffix). No read-modify-write race.
- **In-process ordering**: the per-session mutex serializes appends within one process; the monotonic `seq` counter breaks `Date.now()` ties so batchIds are strictly increasing.
- `getSession` lists all batch files, sorts by filename (lexicographic = chronological), flattens.
- `listSessions` lists `<basePath>/trajectories/*/*.json`, extracts the session directory segment.
- `before` cursor option is documented divergence — ignored (returns all sessions).

## Differences vs sqlite sibling

Contract parity verified by `src/__tests__/{playbook,structured,trajectory,proposal}.test.ts` (#1405).

| Store | Behavior | sqlite | nexus | Notes |
|---|---|---|---|---|
| `PlaybookStore` | `save` same id, same version, different content | Throws "already committed with different content" (version-CAS) | Last-write-wins (overwrites silently) | Callers must not rely on CAS protection with nexus backend |
| `StructuredPlaybookStore` | `save` out-of-order version (e.g., v2 after v3) | Rejected (append-only CAS) | Accepted (last-write-wins) | Nexus can "roll back" version, sqlite cannot |
| `StructuredPlaybookStore` | `getVersion(id, n)` | Returns historical version `n` from lineage table | Always returns `undefined` | #1469 tracks lineage support |
| `TrajectoryStore` | `listSessions({ before: N })` | Filters by last-activity timestamp — sessions with activity >= `before` excluded | Ignores `before` entirely; returns all sessions | Callers needing cursor-based pagination must use sqlite or add client-side filtering |
| `TrajectoryStore` | `listSessions` return order | Descending by last activity timestamp | Filesystem-glob order (undefined) | Sort the result if stable order matters |
| `PlaybookProposalStore` | `listProposals` return order | Ascending by `created_at, id` | Filesystem-glob order (undefined) | Sort the result if stable order matters |
| All stores | No SQL — list ops are O(N) over a glob | SQL `SELECT` with indices | Glob list + client-side filter | Acceptable: ACE list operations are user-driven, not hot-path |
| All stores | Writer concurrency | DB-level locking (WAL + write-lock) | No lock — concurrent writers cause last-write-wins races | Use sqlite for single-host concurrency guarantees |

## Concurrency limits

### `lockScope` — cross-instance lock sharing

The module-level lock registries in `proposal-locks.ts` and `playbook-locks.ts` are keyed by a **`lockScope` string**, not by transport object identity. This means two store instances that point at the **same Nexus backend via different transport objects** (e.g. decorator wrappers, separate HTTP clients to the same URL) can share a lock pool and correctly serialize concurrent writes.

**Rules:**

- Two stores targeting the **same backend** with the **same `basePath`** MUST use the same `lockScope` (or rely on the default).
- The **default** `lockScope` is `basePath` (or `"ace"` if neither is supplied). Safe when each `basePath` maps to exactly one backend in the process and no wrapper transports are involved.
- If you create multiple stores over the same backend with **wrapper transports**, you MUST supply an explicit `lockScope` that is identical across all of those instances.
- Two stores with **different** `lockScope` values get **independent** lock pools — unsafe when they target the same backend.
- `createNexusStructuredPlaybookStore` and `createNexusPlaybookProposalStore` MUST use the **same** `lockScope` when sharing a backend — they coordinate through the same `playbook-locks.ts` registry, which is keyed by scope.

**Audit immutability scope:** `recordProposal` and `recordEvaluation` global-uniqueness
guarantees hold **per process**, enforced by in-memory mutexes keyed by id in
`createNexusPlaybookProposalStore`. Within a single process:

- Concurrent `recordProposal` calls for the same proposal ID are serialised.
  The first writer commits; any subsequent writer with identical content is a
  no-op; a writer with different content throws an immutability error.
- Concurrent `recordEvaluation` calls for the same proposal ID (or the same
  evaluation ID across different proposals) are serialised the same way.

**Cross-process atomicity is not guaranteed.** Two separate processes can both
observe an absent proposal or evaluation file and both commit conflicting records —
last writer wins. True cross-process atomic create-if-absent requires Nexus-level
CAS (etag / `if_match` semantics), which `@koi/nexus-client` does not yet expose.
Distributed deployments must funnel `recordProposal` and `recordEvaluation` writes
through a single coordinator process. Tracking issue: #1469.

**Trajectory ordering:** `getSession` returns entries from concurrent appends in
batchId order, where `batchId = ${Date.now()}-${seqPadded6}-${randomSlice}`. Within
ONE process, batchIds are strictly increasing (the in-process seq counter breaks any
`Date.now()` tie). ACROSS processes, clock skew or same-millisecond appends from
two instances mean batchId order becomes lexicographic on the UUID suffix — i.e.,
append-order is undefined in the multi-process case. Distributed deployments that
depend on strict append-order semantics must funnel writes through a single
coordinator process or attach an explicit `seq` field at the entry level (tracking
issue: #1469 covers adding a `seq` field to `TrajectoryEntry`).

## Connection-loss handling

Each store method propagates transport errors. `read` calls returning NOT_FOUND/EXTERNAL are treated as `undefined`, matching the contract.

## Wiring

Exempt from the orphan check via `koi.optional: true`. L3 selects between sqlite and nexus at assembly time.
