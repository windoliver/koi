# @koi/session

**Layer**: L2 — Feature package  
**Dependencies**: `@koi/core` (L0), `@koi/errors` (L0u)

Provides two implementations of the L0 session contracts for crash recovery:

- **`SessionPersistence`** via SQLite/WAL — durable metadata store for session records and pending outbound frames
- **`SessionTranscript`** via append-only JSONL — per-session conversation log for replay on restart

## Why It Exists

Agents crash. When they do, the engine needs to reconstruct:

1. **What sessions existed** — `SessionPersistence.recover()` returns all session records plus any unsent frames
2. **What the agent said** — `SessionTranscript.load()` replays the full conversation

Without this package, every restart is a cold start. With it, agents resume mid-conversation.

## Module Map

```
src/
├── index.ts                          # Public API re-exports
├── persistence/
│   ├── open-db.ts                    # Inline WAL helper (~20 lines, no @koi/sqlite-utils dep)
│   ├── sqlite-store.ts               # createSqliteSessionPersistence — bun:sqlite backend
│   └── memory-store.ts               # createInMemorySessionPersistence — Map-based, tests only
└── transcript/
    ├── jsonl-store.ts                # createJsonlTranscript — flat JSONL, per-session queue
    └── memory-store.ts               # createInMemoryTranscript — Map-based, tests only
```

## Key APIs

```typescript
// Session persistence (SQLite-backed, WAL mode)
const persistence = createSqliteSessionPersistence({
  dbPath: ".koi/sessions.db",
  durability: "process", // "os" for power-crash safety
});

// Session transcript (flat JSONL append log)
const transcript = createJsonlTranscript({
  baseDir: ".koi/transcripts",
});

// Recovery on startup
const plan = await persistence.recover();
// plan.sessions — all session records
// plan.pendingFrames — Map<sessionId, PendingFrame[]>
// plan.skipped — corrupt rows, per-row error isolation
```

## Design Decisions

### Flat JSONL layout
Files live at `{baseDir}/{sessionId}.jsonl`. No date-partitioned directories.  
O(1) lookup by sessionId. Simpler `append()`, `load()`, `remove()`. Compaction is cleanup.

### Per-session async serialization queue
`compact()` rewrites the file atomically (write-temp → rename). If `append()` races with `compact()`, the rename overwrites the new append — silent data loss. The queue serializes all ops per sessionId. ~20 lines, no external dep.

### All prepared statements at constructor time
All ~10 SQLite queries are `db.prepare()`'d once at construction. Query plans cached for process lifetime. Startup errors visible immediately.

### Batch pending-frame query in `recover()`
`recover()` loads all pending frames in one `SELECT * FROM pending_frames` query, then groups by `sessionId` in memory. Avoids N+1 pattern when recovering many sessions.

### `_schema_version` table (no v1 migrations)
Clean v2 schema. No `ALTER TABLE` migration stubs. `_schema_version = 1` written at DB creation — establishes the migration pattern for future changes.

### `SkippedTranscriptEntry.reason`
JSONL lines that fail to parse are tagged with `reason: "crash_artifact"` (trailing partial write) or `reason: "parse_error"` (real corruption). Callers can route to different log levels without string-matching on `error`.

### SessionId allowlist via `validateSessionIdSyntax`
`@koi/core` provides `validateSessionIdSyntax(id)` — allowlist `/^[a-zA-Z0-9_-]{1,128}$/`. The JSONL store calls this before constructing any filesystem path. Path injection is structurally impossible for valid SessionIds.

## Config

```typescript
interface SessionStoreConfig {
  readonly dbPath: string;          // SQLite file path, or ":memory:" for tests
  readonly durability?: "process" | "os"; // default: "process"
}

interface JsonlTranscriptConfig {
  readonly baseDir: string;         // Directory for .jsonl files
}
```

## Testing

Contract test factories live in `src/__tests__/contracts/`. Both implementations run the same suite:

```typescript
runSessionPersistenceContractTests(() => createInMemorySessionPersistence());
runSessionPersistenceContractTests(() => createSqliteSessionPersistence({ dbPath: ":memory:" }));

runSessionTranscriptContractTests(() => createInMemoryTranscript());
runSessionTranscriptContractTests(() => createJsonlTranscript({ baseDir: tmpDir }));
```

Additional tests specific to each backend:
- `sqlite-store.test.ts` — corruption injection: inserts bad JSON via `bun:sqlite` directly, verifies `recover()` returns the row in `skipped` with `ok: true`
- `jsonl-store.test.ts` — concurrency: `Promise.all(10 appends)` verifies the async queue prevents data loss
