# @koi/playbook-store-sqlite — Persistent ACE Stores

Implements `PlaybookStore`, `StructuredPlaybookStore`, `TrajectoryStore`, and `PlaybookProposalStore` from `@koi/ace-types` over a single local SQLite database. Lets the ACE self-improvement loop (#1715) survive across process restarts so playbooks learned in session 1 apply in session 10.

Tracks issue #2087.

---

## Why It Exists

`@koi/middleware-ace` ships with in-memory backends only. Playbooks die at process exit, defeating the purpose of cross-session learning. This package is the SQLite-backed default for production: zero infra (single file), Bun-native (`bun:sqlite`), and crash-safe via WAL.

It also lands two pieces required for the AGP promotion gate from #1715 that the in-memory baseline does not implement:

- monotonic playbook `version` lineage with `getVersion(id, version)` rollback access
- append-only `PlaybookProposalStore` for `(proposal, evaluation)` pairs

---

## Architecture

```
┌────────────────────────────────────────────┐
│  @koi/playbook-store-sqlite (L2)           │
│                                            │
│  schema.ts        ← DDL + PRAGMAs          │
│  trajectory.ts    ← TrajectoryStore        │
│  playbook.ts      ← PlaybookStore + lineage│
│  structured.ts    ← StructuredPlaybookStore│
│  proposal.ts      ← PlaybookProposalStore  │
│  store.ts         ← createSqlitePlaybookStore (composite factory) │
│  index.ts         ← public API             │
└────────────────────────────────────────────┘
Dependencies: @koi/ace-types, bun:sqlite
```

Single `Database` instance is shared across the four sub-stores so a process holds one file handle and one transaction context.

---

## Schema

```sql
-- Trajectory entries (append-only audit log, ordered by per-session seq).
-- Multiple same-tool calls within a single turn each get their own row.
CREATE TABLE trajectory_entries (
  session_id  TEXT    NOT NULL,
  seq         INTEGER NOT NULL,    -- per-session monotonic counter
  turn_index  INTEGER NOT NULL,
  timestamp   INTEGER NOT NULL,
  kind        TEXT    NOT NULL,    -- 'model_call' | 'tool_call'
  identifier  TEXT    NOT NULL,
  outcome     TEXT    NOT NULL,    -- 'success' | 'failure' | 'retry'
  duration_ms INTEGER NOT NULL,
  metadata    TEXT,                -- JSON, nullable
  bullet_ids  TEXT,                -- JSON array, nullable
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX idx_trajectory_entries_session ON trajectory_entries(session_id, turn_index);

-- Flat playbooks (last-write-wins on id, monotonic version)
CREATE TABLE playbooks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  strategy      TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',  -- JSON array
  confidence    REAL NOT NULL,
  source        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  session_count INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  provenance    TEXT                          -- JSON, nullable
);
CREATE INDEX idx_playbooks_confidence ON playbooks(confidence);

-- Structured playbooks (sections/bullets serialized as JSON)
CREATE TABLE structured_playbooks (
  id                          TEXT PRIMARY KEY,
  title                       TEXT NOT NULL,
  sections                    TEXT NOT NULL,
  tags                        TEXT NOT NULL DEFAULT '[]',
  source                      TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  session_count               INTEGER NOT NULL,
  last_reflected_step_index   INTEGER,
  version                     INTEGER NOT NULL,
  provenance                  TEXT
);

-- Immutable lineage of every committed structured-playbook version.
-- Required by AGP rollback.
CREATE TABLE structured_playbook_versions (
  playbook_id  TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  snapshot     TEXT    NOT NULL,   -- JSON-serialized StructuredPlaybook
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (playbook_id, version)
);

-- Append-only proposals
CREATE TABLE playbook_proposals (
  id                       TEXT PRIMARY KEY,
  playbook_id              TEXT NOT NULL,
  base_version             INTEGER NOT NULL,
  operations               TEXT NOT NULL,   -- JSON
  source_trajectory_range  TEXT NOT NULL,   -- JSON
  reflection               TEXT NOT NULL,   -- JSON
  created_at               INTEGER NOT NULL
);
CREATE INDEX idx_playbook_proposals_playbook ON playbook_proposals(playbook_id, created_at);

-- Append-only evaluations (one per proposal_id, but enforced at app layer)
CREATE TABLE playbook_evaluations (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL,
  verdict       TEXT NOT NULL,   -- 'promote' | 'reject' | 'rollback'
  metrics       TEXT NOT NULL,   -- JSON
  notes         TEXT,
  evaluated_at  INTEGER NOT NULL
);
CREATE INDEX idx_playbook_evaluations_proposal ON playbook_evaluations(proposal_id);
```

PRAGMAs: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `wal_autocheckpoint = 1000`.

---

## API

```typescript
import { createSqlitePlaybookStore } from "@koi/playbook-store-sqlite";

const store = createSqlitePlaybookStore({ path: "./ace.sqlite" });

await store.playbooks.save(pb);
await store.structuredPlaybooks.save(spb);
await store.trajectories.append("session-1", entries);
await store.proposals.recordProposal(prop);

// Rollback support
const previous = await store.structuredPlaybooks.getVersion("pb-1", 3);

store.close();
```

### Config

```typescript
interface SqlitePlaybookStoreConfig {
  /**
   * Database file path. **Required** — there is no global default. Records are
   * keyed only by domain identifiers (no workspace/tenant column), so a shared
   * default file would let learned state from one project bleed into another.
   * Pass a workspace-scoped path (e.g. `<repoRoot>/.koi/ace.sqlite`) or
   * `":memory:"` for tests.
   */
  readonly path: string;
  /** Disk durability. "process" (default) survives process crash; "os" survives power loss. */
  readonly durability?: "process" | "os";
}
```

### Returned shape

```typescript
interface SqlitePlaybookStore {
  readonly playbooks: PlaybookStore;
  readonly structuredPlaybooks: StructuredPlaybookStore;   // includes getVersion
  readonly trajectories: TrajectoryStore;
  readonly proposals: PlaybookProposalStore;
  readonly close: () => void;
}
```

---

## Versioning & Lineage

Every `save()` on a structured playbook writes a row to `structured_playbook_versions` keyed by `(playbook_id, version)`. The current row in `structured_playbooks` is always the latest version; older versions are reachable via `getVersion(id, version)`.

Flat `Playbook` records also carry a `version` column for parity with the type, but lineage is only preserved for `StructuredPlaybook` because that is what the AGP promotion gate operates on.

`save()` rejects (throws `Error`) when:

- an attempted commit would overwrite an existing `(id, version)` pair with different content — versions are immutable once committed
- an attempted commit's `version` is below the current head version — the head pointer never moves backwards

### Rollback workflow

Rollback is a forward-only operation. To restore an older snapshot, read it via `getVersion(id, oldVersion)` and re-commit it as a **new monotonic version** (`headVersion + 1`). The lineage table preserves both the original commit at `oldVersion` and the rollback commit at the new head. This keeps the audit trail intact and makes the rollback itself reversible.

The store enforces two invariants on rollback automatically so callers can't corrupt lineage:

- `lastReflectedStepIndex` is **clamped to `max(current, incoming)`** — a rollback never moves the reflection watermark backwards, so already-processed trajectory windows are not reopened.
- `provenance.committedAt` is **overwritten with the server commit time** for the new version. Other provenance fields (`proposalId`, `evaluationId`, `sourceTrajectoryRange`) are persisted as-is and are the **caller's responsibility** to rewrite — a rollback should pass fresh provenance identifiers (or `undefined`) so the new head doesn't appear to have been produced by the original proposal.

```typescript
const old = await store.structuredPlaybooks.getVersion("pb-1", 3);
if (old !== undefined) {
  const head = await store.structuredPlaybooks.get("pb-1");
  await store.structuredPlaybooks.save({
    ...old,
    version: (head?.version ?? old.version) + 1,
    updatedAt: Date.now(),
    // Rewrite provenance with fresh identifiers for the rollback commit:
    provenance: {
      sourceTrajectoryRange: rollbackRange,
      proposalId: rollbackProposalId,
      evaluationId: rollbackEvalId,
      committedAt: 0, // overwritten server-side
    },
  });
}
```

### Idempotency & key ordering

All stored JSON columns are written through a canonicalizing serializer (object keys sorted at every depth; array order preserved). Idempotent retries therefore succeed even when a re-built payload reorders its keys, as long as the semantic content matches.

---

## Crash Safety

WAL journal + `synchronous = NORMAL` give durability across process kill (`SIGKILL`). The conformance test suite covers a full kill→reopen→state-intact roundtrip: write playbook + trajectory + proposal, force-close the process, re-open the same path, verify all four substores read back identical state.

---

## Wiring

Listed as an optional dependency in `@koi/runtime` (`package.json` + `koi.optional` in `tsconfig.json`) so it is exempt from the orphan check until a default ACE policy is wired. A standalone golden query in `packages/meta/runtime/src/__tests__/golden-replay.test.ts` exercises:

1. open store at temp path
2. save playbook + structured playbook + proposal + trajectory
3. close
4. re-open same path
5. assert `list()` and `getVersion()` return identical state

No LLM cassette needed — the store has no model dependency.

---

## See Also

- `@koi/ace-types` — store interfaces (#1715)
- `@koi/middleware-ace` — in-memory baseline this implementation must conform to
- `@koi/snapshot-store-sqlite` — sibling SQLite L2; reference for tsup `external: ["bun:sqlite"]` setup
- `archive/v1/packages/mm/middleware-ace/src/stores-sqlite.ts` — v1 implementation (no version/lineage/proposals)
