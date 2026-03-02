# @koi/audit-sink-nexus — Nexus-Backed Persistent Audit Logging

Implements the `AuditSink` contract from `@koi/core`, persisting structured audit entries to a Nexus server via JSON-RPC. Supports configurable batch size, flush interval, and retry policy for compliance-grade audit logging.

---

## Why It Exists

`@koi/middleware-audit` intercepts every model call, tool call, and session lifecycle event, then writes a structured `AuditEntry` to a pluggable `AuditSink`. The built-in sinks (console, in-memory) are fine for development, but production needs durable, queryable storage for compliance, debugging, and observability.

Without this package, operators would need to build their own Nexus integration, handle batching, retries, and error policies from scratch.

---

## What This Enables

### Before vs After

```
WITHOUT audit-sink-nexus: audit entries are ephemeral
════════════════════════════════════════════════════

  @koi/middleware-audit
  ┌────────────────────────┐
  │ intercepts model/tool  │
  │ calls, writes entries  │───▶  console.log(entry)  💨 gone
  └────────────────────────┘      or in-memory array   💨 gone on restart


WITH audit-sink-nexus: durable, structured, queryable
═════════════════════════════════════════════════════

  @koi/middleware-audit
  ┌────────────────────────┐     @koi/audit-sink-nexus
  │ intercepts model/tool  │     ┌──────────────────────────┐
  │ calls, writes entries  │────▶│ batches entries (50)      │
  └────────────────────────┘     │ flushes every 5s or full  │
                                 │ retries transient errors   │
                                 └──────────┬───────────────┘
                                            │ JSON-RPC "write"
                                            ▼
                                 ┌──────────────────────────┐
                                 │  Nexus Server             │
                                 │  /audit/{sessionId}/      │
                                 │    1700000000000-0-       │
                                 │      model_call.json      │
                                 │    1700000000042-1-       │
                                 │      tool_call.json       │
                                 │    ...                     │
                                 └──────────────────────────┘
                                   persistent ✓ queryable ✓
```

### What You Can Do With Persistent Audit Logs

- **Compliance**: prove what an agent did, when, and why
- **Debugging**: replay a session's model/tool calls to reproduce issues
- **Observability**: query `durationMs` to find slow model calls
- **Cost tracking**: correlate `model_call` entries with token usage
- **Security auditing**: review `secret_access` and `tool_call` entries for unauthorized actions

---

## Architecture

`@koi/audit-sink-nexus` is a **Layer 2 (L2) feature package** — it imports from `@koi/core` (L0) and L0u utilities only.

```
┌───────────────────────────────────────────────┐
│  @koi/audit-sink-nexus  (L2)                   │
│                                                 │
│  createNexusAuditSink(config) → AuditSink       │
│  ● Batched writes (size + interval triggers)    │
│  ● Retry with exponential backoff               │
│  ● Failed entries re-enqueued (no data loss)    │
│  ● Timer .unref() (won't hold process open)     │
│  ● Path traversal protection on sessionId       │
└────────────┬──────────────┬───────────────────┘
             │              │
             ▼              ▼
   ┌─────────────┐  ┌──────────────┐
   │ @koi/errors  │  │@koi/nexus-   │
   │ (L0u)       │  │ client (L0u) │
   │ withRetry   │  │ rpc("write") │
   │ swallowError│  │              │
   └──────┬──────┘  └──────┬───────┘
          │                │
          ▼                ▼
   ┌──────────────────────────┐
   │  @koi/core (L0)          │
   │  AuditSink, AuditEntry,  │
   │  Result, KoiError         │
   └──────────────────────────┘
```

### File Organization

```
packages/audit-sink-nexus/
├── package.json              # L2 deps: core, errors, nexus-client
├── tsconfig.json             # References L0 + L0u deps
├── tsup.config.ts            # ESM + dts build
└── src/
    ├── index.ts              # Public exports
    ├── config.ts             # NexusAuditSinkConfig + validation
    ├── nexus-sink.ts         # createNexusAuditSink() factory
    └── __tests__/
        ├── sink-contract.ts  # Reusable contract test suite
        └── nexus-sink.test.ts # 21 unit + integration tests
```

---

## How It Works

### Batching Strategy

Entries are buffered in memory and flushed on two triggers:

```
log(entry) called
       │
       ▼
  ┌─────────────┐
  │ append to    │
  │ buffer       │
  └──────┬──────┘
         │
    ┌────┴────┐
    │ buffer  │──── YES ──▶ flushBuffer() fire-and-forget
    │ >= 50?  │
    └────┬────┘
         │ NO
    ┌────┴────────┐
    │ interval    │──── fires every 5s ──▶ flushBuffer()
    │ timer       │
    └─────────────┘

flush() called (session end)
       │
       ▼
  clear timer → flushBuffer() awaited → errors propagate
```

### Error Handling Policy

| Method | On error | Rationale |
|--------|----------|-----------|
| `log()` | Swallowed (fire-and-forget) | Never block the agent loop |
| `flush()` | Thrown to caller | Middleware decides error policy |
| Interval timer | Swallowed | Background; no caller to propagate to |

Failed entries from `flushBuffer()` are **re-enqueued** in the buffer so they can be retried on the next flush. No data loss on partial failures.

### File Path Convention

Each entry is written to Nexus at:

```
{basePath}/{sessionId}/{timestamp}-{turnIndex}-{kind}.json
```

Example:
```
/audit/sess-abc123/1700000000000-0-session_start.json
/audit/sess-abc123/1700000000042-1-model_call.json
/audit/sess-abc123/1700000000100-2-tool_call.json
/audit/sess-abc123/1700000000150-3-session_end.json
```

---

## Configuration

```typescript
interface NexusAuditSinkConfig {
  readonly baseUrl: string;                               // Nexus server URL
  readonly apiKey: string;                                // Nexus API key
  readonly basePath?: string | undefined;                 // Default: "/audit"
  readonly batchSize?: number | undefined;                // Default: 50
  readonly flushIntervalMs?: number | undefined;          // Default: 5_000
  readonly retry?: Partial<RetryConfig> | undefined;      // Default: 3 retries, exp backoff
  readonly fetch?: typeof globalThis.fetch | undefined;   // Injectable for testing
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `baseUrl` | (required) | Nexus server URL |
| `apiKey` | (required) | Bearer token for Nexus auth |
| `basePath` | `"/audit"` | Root path prefix in Nexus storage |
| `batchSize` | `50` | Flush when buffer reaches this size |
| `flushIntervalMs` | `5_000` | Flush at this interval (ms) regardless of buffer size |
| `retry` | `{ maxRetries: 3, backoffMultiplier: 2, initialDelayMs: 1000 }` | Retry policy for transient Nexus errors |
| `fetch` | `globalThis.fetch` | Override for testing with `createFakeNexusFetch()` |

---

## Examples

### Minimal Setup

```typescript
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createNexusAuditSink } from "@koi/audit-sink-nexus";

const sink = createNexusAuditSink({
  baseUrl: "http://nexus.internal:2026",
  apiKey: process.env.NEXUS_API_KEY!,
});

const audit = createAuditMiddleware({ sink });
```

### Full Configuration

```typescript
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createNexusAuditSink } from "@koi/audit-sink-nexus";

const sink = createNexusAuditSink({
  baseUrl: "http://nexus.internal:2026",
  apiKey: process.env.NEXUS_API_KEY!,
  basePath: "/audit/production",
  batchSize: 100,          // larger batches for high-throughput agents
  flushIntervalMs: 10_000, // flush every 10s
  retry: {
    maxRetries: 5,         // more retries for unreliable networks
    initialDelayMs: 500,
    maxBackoffMs: 60_000,
  },
});

const audit = createAuditMiddleware({
  sink,
  redactRequestBodies: true,  // strip model prompts from logs
  maxEntrySize: 20_000,       // truncate large entries
  onError: (error, entry) => {
    console.error("Audit write failed", { error, entryKind: entry.kind });
  },
});
```

### Testing With Fake Nexus

```typescript
import { describe, expect, test } from "bun:test";
import { createFakeNexusFetch } from "@koi/test-utils";
import { createNexusAuditSink } from "@koi/audit-sink-nexus";

test("audit entries are persisted", async () => {
  const sink = createNexusAuditSink({
    baseUrl: "http://fake:2026",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(), // in-memory Nexus
    batchSize: 10,
    flushIntervalMs: 60_000,
    retry: { maxRetries: 0 },
  });

  await sink.log({
    timestamp: Date.now(),
    sessionId: "test-session",
    agentId: "test-agent",
    turnIndex: 0,
    kind: "model_call",
    durationMs: 42,
  });

  await sink.flush?.();
  // entries now in fake Nexus storage
});
```

---

## API Reference

### Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `createNexusAuditSink` | `(config: NexusAuditSinkConfig) => AuditSink` | Factory. Throws on invalid config. |
| `validateNexusAuditSinkConfig` | `(config: NexusAuditSinkConfig) => Result<void, KoiError>` | Validate without creating. |

### Types

| Type | Description |
|------|-------------|
| `NexusAuditSinkConfig` | Configuration for the Nexus audit sink |
| `AuditSink` | Re-exported from `@koi/core` — `{ log, flush? }` |
| `AuditEntry` | Re-exported from `@koi/core` — structured audit event |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_BATCH_SIZE` | `50` | Entries before size-triggered flush |
| `DEFAULT_FLUSH_INTERVAL_MS` | `5_000` | Milliseconds between interval flushes |
| `DEFAULT_BASE_PATH` | `"/audit"` | Root path in Nexus storage |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Per-entry files (not append log) | Nexus is a KV store, not a log system. Individual files enable targeted reads and glob queries. |
| Dual flush triggers (size + interval) | Size trigger handles burst traffic; interval trigger ensures low-traffic entries are persisted within bounded latency. |
| `log()` never throws | Audit logging must never block the agent loop. Errors surface on `flush()` where the middleware can decide policy. |
| Failed entries re-enqueued | Partial batch failures don't cause data loss. Failed entries stay in buffer for next flush attempt. |
| `timer.unref()` | Prevents the interval timer from keeping the process alive if the consumer forgets to call `flush()`. |
| SessionId sanitization | Defense-in-depth: `replace(/[^a-zA-Z0-9_-]/g, "_")` prevents path traversal via crafted session IDs. |
| `Promise.allSettled` (not `Promise.all`) | Writes entries in parallel within a batch. One failing entry doesn't prevent others from succeeding. |
| Injectable `fetch` | Enables testing with `createFakeNexusFetch()` without mocking globals. |

---

## Layer Compliance

- [x] Only imports from `@koi/core` (L0) and L0u packages (`@koi/errors`, `@koi/nexus-client`)
- [x] No imports from `@koi/engine` (L1) or peer L2 packages
- [x] All interface properties `readonly`
- [x] No vendor types in public API
- [x] Injectable `fetch` — no global side effects
- [x] `import type` used for type-only imports (`verbatimModuleSyntax`)
