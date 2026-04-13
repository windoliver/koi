# @koi/middleware-audit — Security-Grade Audit Logging Middleware

Intercepts every model call, tool call, permission decision, config change, and session lifecycle event, writing tamper-evident structured audit entries to a pluggable `AuditSink`. Supports hash chain tamper-detection, optional Ed25519 per-record signing, bounded backpressure, and redaction via `@koi/redaction`.

---

## Why It Exists

Agent runtimes without audit trails have been the root cause of multiple CVE-class security incidents. When an agent makes unexpected decisions — using a tool it shouldn't, accessing sensitive data, receiving a manipulated response — there must be an immutable, tamper-evident record to investigate.

This middleware captures all six categories of auditable events at the sole interposition layer (`KoiMiddleware`), ensuring nothing slips through.

---

## Architecture

`@koi/middleware-audit` is an **L2 feature package** — depends on `@koi/core` (L0), `@koi/errors` (L0u), and `@koi/redaction` (L0u).

```
┌────────────────────────────────────────────────────────────┐
│  @koi/middleware-audit  (L2)                                │
│                                                            │
│  config.ts      ← AuditMiddlewareConfig + validation       │
│  queue.ts       ← bounded ring buffer + drain loop        │
│  signing.ts     ← hash chain + Ed25519 signing            │
│  audit.ts       ← middleware factory                      │
│  index.ts       ← public API surface                      │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Dependencies                                              │
│                                                            │
│  @koi/core      KoiMiddleware, AuditEntry, AuditSink,      │
│                 SessionContext, TurnContext,                │
│                 PermissionQuery, PermissionDecision,        │
│                 ConfigChange                               │
│                                                            │
│  @koi/errors    KoiRuntimeError, swallowError              │
│  @koi/redaction createRedactor, Redactor                   │
└────────────────────────────────────────────────────────────┘
```

---

## Event Categories Captured

| `AuditEntry.kind` | Hook | Notes |
|---|---|---|
| `model_call` | `wrapModelCall` + `wrapModelStream` | Request + response (or error) + duration |
| `tool_call` | `wrapToolCall` | Input + output (or error) + duration |
| `session_start` | `onSessionStart` | Session metadata |
| `session_end` | `onSessionEnd` | Awaits queue flush before returning |
| `permission_decision` | `onPermissionDecision` | Query + decision (allow/deny/ask) |
| `config_change` | `onConfigChange` | Key + oldValue + newValue |

---

## Tamper Evidence

Every entry carries `schema_version: 1`.

When signing is enabled, two additional fields are added:

- `prev_hash`: SHA-256 hex of the previous entry's full canonical JSON (genesis entry uses `"0".repeat(64)`). Detects insertion, deletion, or reordering.
- `signature`: Base64url Ed25519 signature over `JSON.stringify(entryWithoutSignature)`. Provides non-repudiation.

---

## Backpressure

The agent loop is **never blocked** by audit writes. Entries are enqueued in a bounded in-memory ring buffer (default depth: 1000). On overflow, the oldest entry is dropped and `onOverflow(entry, droppedCount)` is called. A background drain loop writes to the sink asynchronously.

`flush()` drains all pending entries synchronously, then calls `sink.flush?.()`. It is called automatically on `onSessionEnd` and is available on the returned middleware object for tests and graceful shutdown.

---

## Redaction

Redaction is applied **before** serialization using `@koi/redaction`'s `createRedactor()`. The redactor walks the structured payload object, censoring secret-matching leaf values. This is a single JSON stringify pass — no triple-serialize cycle.

Configure via `redaction?: Partial<RedactionConfig>` in the middleware config (passed directly to `createRedactor()`). The full built-in secret detector library (13 patterns) is available.

---

## API

```typescript
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createNdjsonAuditSink } from "@koi/audit-sink-ndjson";

const sink = createNdjsonAuditSink({ filePath: "./audit.ndjson" });

const audit = createAuditMiddleware({
  sink,
  maxQueueDepth: 1000,
  signing: true,               // generate ephemeral Ed25519 keypair
  redactRequestBodies: false,
  onOverflow: (entry, count) => {
    console.warn(`Audit overflow: dropped ${count} entries`);
  },
});

// audit.signingPublicKey — Buffer (DER) of the public key, if signing enabled
// audit.flush()          — drain all pending entries + sink.flush()
```

### Config

```typescript
interface AuditMiddlewareConfig {
  readonly sink: AuditSink;
  readonly redaction?: Partial<RedactionConfig>;
  readonly redactRequestBodies?: boolean;
  readonly maxEntrySize?: number;               // default: 10_000 chars
  readonly maxQueueDepth?: number;              // default: 1000
  readonly onOverflow?: (entry: AuditEntry, droppedCount: number) => void;
  readonly onError?: (error: unknown, entry: AuditEntry) => void;
  readonly signing?: boolean | { readonly privateKey: CryptoKey };
}
```

---

## Tests

```bash
bun test --filter=@koi/middleware-audit
```

Test files:
- `audit.test.ts` — core middleware behavior (all 6 event kinds, redaction, truncation, error paths)
- `backpressure.test.ts` — overflow, drain, queue bound
- `signing.test.ts` — Ed25519 signature presence and verification
- `hash-chain.test.ts` — chain continuity, genesis sentinel, tamper detection

---

## See Also

- `@koi/audit-sink-ndjson` — buffered file sink (NDJSON)
- `@koi/audit-sink-sqlite` — SQLite sink with WAL mode and time+kind index
- `@koi/redaction` — secret pattern detection and field-name censoring
- `@koi/core` `AuditEntry` — the canonical record shape

> **Ed25519 signing — TextEncoder payloads (#1742):** `signing.ts` now builds the canonical payload via `TextEncoder` + `new Uint8Array(...)` instead of `Buffer.from(...)`. `Buffer` is a Node.js global that the TS 6 strict DTS build can't statically resolve under `isolatedDeclarations`, so it broke the package's `.d.ts` emit. The Web Crypto interface only requires `BufferSource`; `Uint8Array` satisfies that and is portable to non-Node hosts. No behavioral change — the canonical bytes are byte-for-byte identical for any UTF-8 input.
