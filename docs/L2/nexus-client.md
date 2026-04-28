# @koi/nexus-client

**Layer:** L0u
**Package:** `packages/lib/nexus-client`

Shared JSON-RPC 2.0 HTTP transport for all Nexus server communication.
Extracted from `@koi/fs-nexus` when `@koi/permissions-nexus` became the second consumer.

## Purpose

Provides `createHttpTransport` — a typed, retrying, deadline-aware HTTP client
for Nexus JSON-RPC endpoints. All Nexus calls use the pattern:

```
POST {url}/api/nfs/{method}
Content-Type: application/json
Authorization: Bearer {apiKey}   (optional)

{ "jsonrpc": "2.0", "id": N, "method": "...", "params": {...} }
```

## API

```typescript
import { createHttpTransport } from "@koi/nexus-client";

const transport = createHttpTransport({
  url: "http://localhost:3100",
  apiKey: "secret",
  deadlineMs: 45_000,   // total budget including retries; default 45s
  retries: 2,           // retry count for safe methods; default 2
});

const result = await transport.call<string>("read", { path: "koi/policy.json" });
if (result.ok) {
  console.log(result.value);
}

transport.close(); // abort in-flight requests
```

## NexusTransport interface

```typescript
interface NexusTransport {
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
  readonly close: () => void;
}
```

## Retry policy

Read-only methods (`read`, `list`, `grep`, `search`, `stat`, `exists`, `glob`,
`is_directory`, `permissions.check`, `permissions.checkBatch`, `revocations.check`,
`revocations.checkBatch`, `version`) are retried up to `retries` times with
exponential backoff + 20% jitter. Write methods are not retried (non-idempotent).

## Error semantics

Returns `Result<T, KoiError>` — never throws. Network timeouts map to
`code: "TIMEOUT"`, HTTP 5xx to `code: "INTERNAL"`, HTTP 4xx to `code: "EXTERNAL"`,
JSON-RPC errors to their mapped code. All errors carry `retryable` flag.
