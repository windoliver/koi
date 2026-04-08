# @koi/session

**Layer**: L2 — Feature package  
**Dependencies**: `@koi/core` (L0), `@koi/errors` (L0u), `@koi/session-repair` (L0u)

Provides two implementations of the L0 session contracts for crash recovery, plus a pure resume function for converting transcript history back to engine-ready messages:

- **`SessionPersistence`** via SQLite/WAL — durable metadata store for session records and pending outbound frames
- **`SessionTranscript`** via append-only JSONL — per-session conversation log for replay on restart
- **`resumeFromTranscript()`** — pure function: `TranscriptEntry[]` → `InboundMessage[]` for engine replay

## Why It Exists

Agents crash. When they do, the engine needs to reconstruct:

1. **What sessions existed** — `SessionPersistence.recover()` returns all session records plus any unsent frames
2. **What the agent said** — `SessionTranscript.load()` replays the full conversation
3. **What messages to replay** — `resumeFromTranscript()` converts the transcript to InboundMessages the engine can feed back to the model

Without this package, every restart is a cold start. With it, agents resume mid-conversation.

## Module Map

```
src/
├── index.ts                          # Public API re-exports
├── resume.ts                         # resumeFromTranscript() + resumeForSession()
├── persistence/
│   ├── open-db.ts                    # Inline WAL helper (~25 lines, no @koi/sqlite-utils dep)
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
  durability: "process", // "os" for power-crash safety (macOS: uses F_FULLFSYNC)
});

// Session transcript (flat JSONL append log)
const transcript = createJsonlTranscript({
  baseDir: ".koi/transcripts",
});

// Recovery on startup
const plan = await persistence.recover();
// plan.sessions — all session records (each has status: "running"|"idle"|"done")
// plan.pendingFrames — Map<sessionId, PendingFrame[]>
// plan.skipped — corrupt rows, per-row error isolation

// Status management (for crash detection: "running" after restart = crash candidate)
await persistence.setSessionStatus(sessionId, "running");  // on session start
await persistence.setSessionStatus(sessionId, "idle");     // on session pause

// Content replacement tracking (for @koi/context-manager)
await persistence.saveContentReplacement({
  sessionId, messageId, filePath, byteCount, replacedAt: Date.now(),
});
const replacements = await persistence.loadContentReplacements(sessionId);

// Compact transcript: summarize old entries, preserve last N
// Returns CompactResult: { preserved: number, extended: boolean }
// extended=true means the boundary was pushed back to avoid splitting a tool_call/tool_result pair
const result = await transcript.compact(sessionId, "Summary of first 10 turns", 5);

// Resume a crashed session: transcript → InboundMessages
const { messages, issues } = (await resumeForSession(sessionId, transcript)).value;
// messages: InboundMessage[] ready for the engine's context builder
// issues: RepairIssue[] from repairSession() (orphan repairs, deduplication, merges)
```

## Design Decisions

### Flat JSONL layout
Files live at `{baseDir}/{encodeURIComponent(sessionId)}.jsonl`. No date-partitioned directories.  
O(1) lookup by sessionId. Simpler `append()`, `load()`, `remove()`. Path traversal is structurally impossible — encoding converts `/` and `:` to `%2F` and `%3A`.

### Per-session async serialization queue (instance-local)
`compact()` rewrites the file atomically (write-temp → rename). If `append()` races with `compact()`, the rename overwrites the new append — silent data loss. The queue serializes all ops per sessionId. The Map is instance-local (inside `createJsonlTranscript`) so separate instances in tests don't share state.

### `compact()` boundary extension
`compact(sid, summary, preserveLastN)` extends `preserveLastN` backward if the naive cut would split a `tool_call`/`tool_result` pair. A split pair causes replay to fail because the model sees an orphan result. The function returns `CompactResult.extended=true` when this happens so the context-manager can reconcile its token accounting.

### Engine-injected `system:*` sender preservation
The session transcript middleware recognizes `system:*` prefixed senders
(e.g., `system:doom-loop`, `system:capabilities`) as system role and stores
the original `senderId` in `TranscriptEntry.metadata.senderId`. On resume,
entries with a stored `system:*` sender are replayed with the original
privileged sender — not downgraded to `"user"` like plain `"system"` entries.
This ensures engine-injected guardrails (doom loop, capability injection)
survive session persistence and remain in system prompt context after restart.

### `resumeFromTranscript()` — positional tool pairing
`tool_call` entries in the transcript carry an array of `{id, toolName, args}` calls. The corresponding `tool_result` entries are positional (nth result matches nth call). `resumeFromTranscript()` matches them by queuing callIds and consuming positionally. Dangling calls (crash before tool completed) get synthetic error tool_results (`metadata.isError=true`). The final pass calls `repairSession()` to clean up any remaining orphans.

### SQLite schema v2 with instant migration
v2 adds `status TEXT NOT NULL DEFAULT 'idle'` to `session_records` and a new `content_replacements` table. Existing v1 databases are migrated via `ALTER TABLE ADD COLUMN` with `DEFAULT` — SQLite executes this instantly (no table rewrite). The `content_replacements` table is created fresh (no data to migrate).

### `runSync<T>()` helper
Eliminates 9 identical try/catch blocks in sqlite-store. The helper catches all DB/parse exceptions and returns `Result<T, KoiError>` with `INTERNAL` error code. Methods that need `NOT_FOUND` errors (loadSession, removeSession, setSessionStatus) perform the null/changes check **outside** `runSync` — throwing a `KoiError` inside `runSync` would wrap it with `INTERNAL`, losing the error code.

### `fullfsync=1` on macOS
When `durability="os"`, WAL+FULL sync mode is enabled. On macOS, POSIX `fsync` does not flush hardware write buffers — only `F_FULLFSYNC` does. `PRAGMA fullfsync = 1` activates this. No-op on Linux/Windows.

### All prepared statements at constructor time
All ~12 SQLite queries are `db.prepare()`'d once at construction. Query plans cached for process lifetime. Startup errors visible immediately.

### Batch pending-frame query in `recover()`
`recover()` loads all pending frames in one `SELECT * FROM pending_frames` query, then groups by `sessionId` in memory. Avoids N+1 pattern when recovering many sessions.

## Config

```typescript
interface SessionStoreConfig {
  readonly dbPath: string;                  // SQLite file path, or ":memory:" for tests
  readonly durability?: "process" | "os";   // default: "process"
}

interface JsonlTranscriptConfig {
  readonly baseDir: string;                 // Directory for .jsonl files
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
- `sqlite-store.test.ts` — corruption injection, status lifecycle, content replacement round-trips, v1→v2 migration
- `jsonl-store.test.ts` — concurrency (`Promise.all(10 appends)`), crash artifact detection, compaction boundary extension (cases A/B/C)
- `resume.test.ts` — empty/compaction-only/tool-pair/dangling/orphan cases, determinism, validation
