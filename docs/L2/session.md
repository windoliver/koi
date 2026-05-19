# @koi/session

**Layer**: L2 — Feature package  
**Dependencies**: `@koi/core` (L0), `@koi/errors` (L0u), `@koi/nexus-client` (L0u), `@koi/session-repair` (L0u)

Provides two implementations of the L0 session contracts for crash recovery, plus a pure resume function for converting transcript history back to engine-ready messages:

- **`SessionPersistence`** via SQLite/WAL — durable metadata store for session records and pending outbound frames
- **`SessionTranscript`** via append-only JSONL — per-session conversation log for replay on restart
- **Nexus session backend** — opt-in remote composition of `SessionPersistence`, `SessionTranscript`, checkpoint state, and session-scoped artifacts
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
├── nexus/
│   ├── session-backend.ts            # createNexusSessionBackend — composed Nexus backend
│   ├── transcript-store.ts           # SessionTranscript over Nexus JSONL files
│   ├── persistence-store.ts          # SessionPersistence over Nexus JSON files
│   ├── artifact-store.ts             # session-scoped artifact persistence
│   ├── json-io.ts                    # Nexus read/write/list/delete helpers
│   ├── paths.ts                      # namespace layout and path validation
│   └── types.ts                      # Nexus backend and artifact contracts
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

// Nexus-backed session state (opt-in; local stores remain the default)
const nexus = createNexusSessionBackend({
  transport,
  basePath: "sessions",
});
await nexus.saveTurn(sessionId, transcriptEntry);
await nexus.saveCheckpoint(sessionId, engineState);
await nexus.artifacts.saveArtifact(sessionId, {
  artifactId: "tool-output",
  content: JSON.stringify(output),
  contentType: "application/json",
  createdAt: Date.now(),
});
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

### `system:internal:*` sender skip (transcript pollution guard)
Inbound messages whose `senderId` starts with `system:internal:` are NOT
persisted to the transcript on commit. These are middleware-injected scratch
messages — for example, `system:internal:verifier` (output-verifier revise
feedback) and `system:internal:verifier-replay` (the prior assistant turn
replayed for context). They drive in-flight model behavior but must not
corrupt the durable transcript: if persisted, a successful revise pass would
commit the verifier feedback as the turn's input and leak judge/check signal
into resume context. The skip is at commit time only — the message still
reaches the model adapter on the live call.

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

### Nexus session backend composition
`createNexusSessionBackend()` deliberately composes existing contracts instead
of introducing a parallel L0 `SessionBackend` abstraction. Its
`transcript` member implements `SessionTranscript`, its `persistence` member
implements `SessionPersistence`, and the high-level helpers
`saveTurn/loadHistory/saveCheckpoint/loadCheckpoint` are thin conveniences over
those contracts. This keeps existing local SQLite/JSONL stores as the default
and lets assembly/runtime code select Nexus explicitly when remote durability is
required.

### Nexus namespace layout
All paths live under `basePath` (default `"sessions"`), with URL-encoded session
IDs and artifact IDs so runtime IDs containing `/` or `:` cannot escape the
namespace:

```
<basePath>/transcripts/<sessionId>.jsonl
<basePath>/records/<sessionId>.json
<basePath>/pending/<sessionId>/<frameId>.json
<basePath>/content-replacements/<sessionId>/<messageId>.json
<basePath>/artifacts/<sessionId>/<artifactId>.json
```

Transcript history remains append-first JSONL at the contract surface. Because
the current Nexus file RPC exposes read/write rather than an atomic append verb,
the v2 adapter serializes per-session transcript mutations in-process, reads
the existing JSONL, appends new lines, and writes the file back. A future Nexus
append RPC can replace that internal implementation without changing callers.

### Nexus checkpoint and artifact state
Checkpoint state is stored in the existing `SessionRecord.lastEngineState`
field and updated through `SessionPersistence.updateLastEngineState()` with the
same `expectedVersion` CAS behavior used by local stores. Session-scoped
artifacts are intentionally separate from `@koi/artifacts`: this first slice
needs durable per-session tool outputs, not the full versioned artifact
lifecycle. The artifact store persists plain JSON records under the session
artifact namespace and can later be backed by content-addressed storage without
changing the session backend facade.

## Cancel-Resume (issue #1683)

When an engine adapter implements `saveState`/`loadState`, this package's
`wrapAdapterWithStatePersistence` opts into durable cancel-resume:

- **On cancel** (`done.stopReason === "interrupted"`): the wrapper calls
  `inner.saveState()`, then writes the resulting `EngineState` to the
  session row via `SessionPersistence.updateLastEngineState` with atomic
  CAS (`expectedVersion`). The L0 contract gained an optional
  `expectedVersion?: number` parameter on `updateLastEngineState`; both
  bundled stores reject with `CONFLICT` when the row's `lastPersistedAt`
  doesn't match. Stores without atomic CAS are refused at wrap time.
- **On resume**: `resumeWithEngineState` returns
  `{ messages, lastEngineState, lastPersistedAt }`. The host passes
  `lastEngineState` as `initialEngineState` and `lastPersistedAt` as
  `initialEngineStateVersion` to the wrapper so cross-process safety is
  enforced from the moment of resume.
- **On `loadState` failure**: the wrapper signals the host via
  `onPersistError`, atomically clears the unloadable checkpoint via CAS
  (CONFLICT → silent back-off so a newer concurrent write isn't
  clobbered), and yields a synthetic `done(stopReason="error")` instead
  of calling `inner.stream`. This is fail-closed: a richer adapter that
  partially mutates its cursor before throwing cannot leak that state
  into a live run; the host rebuilds a fresh adapter for transcript-only
  retry.
- **On non-interrupted terminal** (`completed`/`error`/`max_turns`):
  the stale checkpoint is cleared via CAS so the next resume falls
  back to transcript-only.

Persistent invariants:
- Cross-process / cross-runtime CAS via `expectedVersion` prevents two
  TUIs sharing a database from clobbering each other's checkpoints.
- A wrapper-scoped generation token plus a strict 5s persist deadline
  drop stale interrupted writes that would otherwise race past a
  subsequent terminal.
- For schemes where no atomic CAS exists in the store, the wrapper
  refuses construction rather than fall back to a load-merge-save path
  that can resurrect stale checkpoints.

## Transcript Truncation for Checkpoint Rewind

`SessionTranscript.truncate(sessionId, keepCount)` removes all entries beyond `keepCount` from the transcript log. This is used by the checkpoint rewind flow to roll back conversation state to a prior checkpoint: after a rewind, the transcript is truncated to the checkpoint boundary so that subsequent `load()` returns only the entries up to the rewound point. The operation is atomic (write-temp + rename) and serialized via the per-session queue, consistent with `compact()`.

## Config

```typescript
interface SessionStoreConfig {
  readonly dbPath: string;                  // SQLite file path, or ":memory:" for tests
  readonly durability?: "process" | "os";   // default: "process"
}

interface JsonlTranscriptConfig {
  readonly baseDir: string;                 // Directory for .jsonl files
}

interface NexusSessionBackendConfig {
  readonly transport: NexusTransport;
  readonly basePath?: string;               // default: "sessions"
  readonly lockScope?: string;              // default: basePath
}
```

### Trajectory Visibility

Reports `{action: "record", entries, toolCalls}` via `ctx.reportDecision()` on `wrapModelStream` when transcript entries are committed, and `{action: "record", toolId}` on `wrapToolCall`. Shows `[record:N]` in the TUI trajectory view.

## Testing

Contract test factories live in `src/__tests__/contracts/`. Both implementations run the same suite:

```typescript
runSessionPersistenceContractTests(() => createInMemorySessionPersistence());
runSessionPersistenceContractTests(() => createSqliteSessionPersistence({ dbPath: ":memory:" }));
runSessionPersistenceContractTests(() => createNexusSessionBackend({ transport }).persistence);

runSessionTranscriptContractTests(() => createInMemoryTranscript());
runSessionTranscriptContractTests(() => createJsonlTranscript({ baseDir: tmpDir }));
runSessionTranscriptContractTests(() => createNexusSessionBackend({ transport }).transcript);
```

Additional tests specific to each backend:
- `sqlite-store.test.ts` — corruption injection, status lifecycle, content replacement round-trips, v1→v2 migration
- `jsonl-store.test.ts` — concurrency (`Promise.all(10 appends)`), crash artifact detection, compaction boundary extension (cases A/B/C)
- `nexus/session-backend.test.ts` — Nexus contract parity, high-level history/checkpoint helpers, session-scoped artifact isolation
- `resume.test.ts` — empty/compaction-only/tool-pair/dangling/orphan cases, determinism, validation
