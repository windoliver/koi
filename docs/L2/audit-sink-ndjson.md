# @koi/audit-sink-ndjson — Buffered NDJSON File Sink

Implements `AuditSink` from `@koi/core`, writing audit entries to a local NDJSON file using a buffered write stream. One JSON object per line, append-only.

---

## Why It Exists

`@koi/middleware-audit` needs a durable, simple sink for local deployments and log shipping pipelines. NDJSON (newline-delimited JSON) is universally supported by log aggregators (Loki, Splunk, Datadog, Fluentd), easy to tail with `tail -f`, and trivially parseable.

This sink uses a buffered write stream — not one `appendFile()` syscall per record — so it stays performant at high event frequency.

---

## Architecture

```
┌───────────────────────────────────────────┐
│  @koi/audit-sink-ndjson  (L2)             │
│                                           │
│  config.ts       ← config + validation   │
│  ndjson-sink.ts  ← factory + writer      │
│  index.ts        ← public API            │
└───────────────────────────────────────────┘
Dependencies: @koi/core, @koi/errors
```

Zero external dependencies. Uses Bun's built-in file writer API.

---

## Behavior

- On creation: opens a `Bun.file(filePath).writer()` write stream once.
- `log(entry)`: serializes to JSON + `\n`, appends to the in-memory buffer. No syscall per record.
- Flush triggers: `setInterval` (default 2s) or explicit `flush()` call.
- `flush()`: flushes the Bun writer to disk.
- `close()`: clears the interval, final flush, ends the writer.
- Redaction is **not** applied in the sink — it is the middleware's responsibility.

---

## API

```typescript
import { createNdjsonAuditSink } from "@koi/audit-sink-ndjson";

const sink = createNdjsonAuditSink({
  filePath: "./audit.ndjson",
  flushIntervalMs: 2000,  // default
});

// sink.log(entry)    — AuditSink.log
// sink.flush()       — force flush to disk
// sink.close()       — shutdown (flush + end writer)
// sink.getEntries()  — read + parse all entries from file (for testing)
```

### Config

```typescript
interface NdjsonRotationConfig {
  /** Rotate when file exceeds this many bytes. No limit if omitted. */
  readonly maxSizeBytes?: number;
  /** Rotate at day boundary (UTC). Default: false. */
  readonly daily?: boolean;
}

interface NdjsonAuditSinkConfig {
  readonly filePath: string;
  readonly flushIntervalMs?: number;  // default: 2000
  readonly rotation?: NdjsonRotationConfig;
}
```

---

## Log Rotation

When `rotation` is configured, the sink automatically rotates the active file:

- **Size-based**: when bytes written to the current file exceeds `maxSizeBytes`, the file is archived and a fresh file is opened.
- **Daily**: when the UTC calendar day advances, the current file is archived before the first write of the new day.

Rotated files are moved into `<filePath>.archive/` with an ISO timestamp prefix (e.g. `2026-04-25T12-34-56-789Z.ndjson`). The archive directory is created automatically.

`getEntries()` and `query()` scan all archived files (in chronological order) plus the current file, so hash-chain verification and session queries span rotation boundaries transparently.

### Hash-chain continuity

The hash chain (`prev_hash` field) is maintained by `@koi/middleware-audit`, not by this sink. Because the chain is embedded in each `AuditEntry`, rotation is transparent to chain verification: the first entry written to a new file carries `prev_hash` pointing to the last entry of the previous file. Verifying the full chain requires reading all archive files for the session, which `query()` does automatically.

### Rotation contract

- Rotation **archives**, never deletes. Old files are retained in `<filePath>.archive/` indefinitely.
- The active file is the only file being written. Archived files are read-only by convention.
- Rotation is synchronous with the write that triggers it — `log()` awaits the rotate before returning.

---

## Compliance events

When this sink is wired via `--audit-ndjson`, `runtime-factory.ts` also wraps
it in `createAuditSinkComplianceRecorder` from `@koi/governance-defaults`.
Every governance verdict produces one extra NDJSON line with
`kind: "compliance_event"` — no separate flag required.

---

## See Also

- `@koi/middleware-audit` — the middleware that writes to this sink
- `@koi/audit-sink-sqlite` — SQLite sink for queryable local storage
