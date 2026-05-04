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
<basePath>/trajectories/<sessionId>.json
<basePath>/proposals/<proposalId>.json
<basePath>/proposals-by-playbook/<playbookId>/<proposalId>.json   (index)
<basePath>/evaluations/<proposalId>.json
```

`basePath` defaults to `"ace"`. IDs are sanitized — colons in session IDs become `_` so Nexus list/glob can index them.

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

## Connection-loss handling

Each store method propagates transport errors. `read` calls returning NOT_FOUND/EXTERNAL are treated as `undefined`, matching the contract.

## Wiring

Exempt from the orphan check via `koi.optional: true`. L3 selects between sqlite and nexus at assembly time.
