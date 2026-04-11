# @koi/audit-sink-sqlite — SQLite Sink with WAL Mode

Implements `AuditSink` from `@koi/core`, writing audit entries to a local SQLite database using batched inserts. WAL mode enabled for concurrent reads. Composite `(timestamp, kind)` index for time-range + kind queries.

---

## Why It Exists

`@koi/audit-sink-ndjson` is great for log shipping but not for querying. When you need "show me all `tool_call` entries in the last hour" or "what did this session do?", you need a queryable store. SQLite gives you SQL queries, indexes, and transactions — with zero infrastructure.

---

## Architecture

```
┌────────────────────────────────────────────┐
│  @koi/audit-sink-sqlite  (L2)              │
│                                            │
│  config.ts      ← config + validation     │
│  schema.ts      ← DDL + WAL + indexes     │
│  sqlite-sink.ts ← factory + batch writer  │
│  index.ts       ← public API              │
└────────────────────────────────────────────┘
Dependencies: @koi/core, @koi/errors, bun:sqlite
```

---

## Schema

```sql
CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version  INTEGER NOT NULL,
  timestamp       INTEGER NOT NULL,
  session_id      TEXT    NOT NULL,
  agent_id        TEXT    NOT NULL,
  turn_index      INTEGER NOT NULL,
  kind            TEXT    NOT NULL,
  request         TEXT,
  response        TEXT,
  error           TEXT,
  duration_ms     INTEGER NOT NULL,
  prev_hash       TEXT,
  signature       TEXT,
  metadata        TEXT
);
-- Session lookup (existing access pattern)
CREATE INDEX idx_audit_log_session ON audit_log(session_id);
-- Time-range + kind queries (new)
CREATE INDEX idx_audit_log_ts_kind ON audit_log(timestamp, kind);
```

WAL journal mode is enabled automatically (`PRAGMA journal_mode = WAL`). Allows concurrent reads while the agent is writing.

---

## Behavior

- Entries are buffered in memory and flushed in transactions (default: every 2s or 100 entries).
- `flush()`: flushes buffer synchronously (used in `onSessionEnd` drain).
- `close()`: clearInterval + final flush + `db.close()`.
- Row mapping: all DB columns validated with explicit type guards — no `as` casts.

---

## API

```typescript
import { createSqliteAuditSink } from "@koi/audit-sink-sqlite";

const sink = createSqliteAuditSink({
  dbPath: "./audit.db",
  flushIntervalMs: 2000,   // default
  maxBufferSize: 100,      // default
});

// sink.log(entry)         — AuditSink.log (buffered)
// sink.flush()            — flush buffer to DB
// sink.query(sessionId)   — query entries for session
// sink.getEntries()       — read all entries (for testing)
// sink.close()            — shutdown
```

### Config

```typescript
interface SqliteAuditSinkConfig {
  readonly dbPath: string;
  readonly flushIntervalMs?: number;  // default: 2000
  readonly maxBufferSize?: number;    // default: 100
}
```

---

## Common Queries

```sql
-- All events in the last hour
SELECT * FROM audit_log
WHERE timestamp > unixepoch('now', '-1 hour') * 1000
ORDER BY timestamp;

-- All tool calls for a session
SELECT * FROM audit_log
WHERE session_id = ? AND kind = 'tool_call'
ORDER BY id;

-- Permission denials today
SELECT * FROM audit_log
WHERE kind = 'permission_decision'
  AND json_extract(response, '$.effect') = 'deny'
  AND timestamp > unixepoch('now', 'start of day') * 1000;
```

---

## See Also

- `@koi/middleware-audit` — the middleware that writes to this sink
- `@koi/audit-sink-ndjson` — NDJSON sink for log shipping
