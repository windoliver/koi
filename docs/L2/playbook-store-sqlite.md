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
-- Trajectory entries (append-heavy, partitioned by session_id)
CREATE TABLE trajectory_entries (
  session_id  TEXT    NOT NULL,
  turn_index  INTEGER NOT NULL,
  timestamp   INTEGER NOT NULL,
  kind        TEXT    NOT NULL,    -- 'model_call' | 'tool_call'
  identifier  TEXT    NOT NULL,
  outcome     TEXT    NOT NULL,    -- 'success' | 'failure' | 'retry'
  duration_ms INTEGER NOT NULL,
  metadata    TEXT,                -- JSON, nullable
  bullet_ids  TEXT,                -- JSON array, nullable
  PRIMARY KEY (session_id, turn_index, identifier)
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
  /** Database file path. Use ":memory:" for tests. Default: "~/.koi/ace.sqlite". */
  readonly path?: string;
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

`save()` rejects (throws `Error`) when an attempted commit would overwrite an existing `(id, version)` pair with different content — versions are immutable once committed.

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
