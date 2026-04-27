# @koi/audit-sink-nexus

**Layer:** L2
**Package:** `packages/security/audit-sink-nexus`
**Issue:** #1399

Nexus-backed `AuditSink` — batched writes with interval + size triggers,
and a `query()` method that reads entries back from Nexus NFS.

## API

```typescript
import { createNexusAuditSink } from "@koi/audit-sink-nexus";
import { createHttpTransport } from "@koi/nexus-client";

const sink = createNexusAuditSink({
  transport: createHttpTransport({ url: "http://nexus:3100" }),
  basePath: "koi/audit",      // default
  batchSize: 20,              // default — flush when buffer reaches this size
  flushIntervalMs: 5_000,     // default — flush every 5s
});

await sink.log(entry);        // buffered, fire-and-forget
await sink.flush();           // explicit flush, propagates write errors
const entries = await sink.query("session-id"); // flush then read from Nexus
```

## Storage layout

Each entry is written to:
```
{basePath}/{sessionId}/{timestamp}-{turnIndex}-{kind}-{seq}.json
```

`query()` lists the session directory, reads all files, and sorts by
`(timestamp, turnIndex)`. Malformed files are silently skipped.

## Error semantics

- `log()` — fire-and-forget; write errors re-enqueue failed entries for retry on next flush
- `flush()` — propagates write errors to caller; caller (middleware) applies its own error policy
- `query()` — flushes first, then reads; list/read errors return empty for that file
