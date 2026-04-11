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
interface NdjsonAuditSinkConfig {
  readonly filePath: string;
  readonly flushIntervalMs?: number;  // default: 2000
}
```

---

## See Also

- `@koi/middleware-audit` — the middleware that writes to this sink
- `@koi/audit-sink-sqlite` — SQLite sink for queryable local storage
