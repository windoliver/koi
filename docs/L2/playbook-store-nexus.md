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

- No SQL — list ops are O(N) over a glob. Acceptable: ACE list operations are user-driven, not hot-path.
- No `getVersion()` lineage — sqlite uses an indexed `version` column; nexus stores only the latest version per ID. The optional `getVersion` returns `undefined` to signal lineage is unavailable. Documented as a known gap; #1469 tracks the lineage solution.
- `storeId` is derived from the configured `basePath` (deterministic per mount) rather than per-database UUID. ACE's resume guard tolerates this — it cares about "did the database move under me", and the nexus mount has its own identity.
- No writer lock — ACE in distributed mode tolerates concurrent updates (last-write-wins on `version`). Single-host concurrent writers must use the sqlite backend.

## Connection-loss handling

Each store method propagates transport errors. `read` calls returning NOT_FOUND/EXTERNAL are treated as `undefined`, matching the contract.

## Wiring

Exempt from the orphan check via `koi.optional: true`. L3 selects between sqlite and nexus at assembly time.
