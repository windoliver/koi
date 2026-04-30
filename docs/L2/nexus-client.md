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
  readonly kind?: "http" | "local-bridge" | "probe";
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
    opts?: NexusCallOptions,
  ) => Promise<Result<T, KoiError>>;
  readonly health?: (opts?: NexusHealthOptions) => Promise<Result<NexusHealth, KoiError>>;
  readonly close: () => void;
}

interface HealthCapableNexusTransport extends NexusTransport {
  readonly health: (opts?: NexusHealthOptions) => Promise<Result<NexusHealth, KoiError>>;
}

interface NexusCallOptions {
  readonly deadlineMs?: number;       // override default per call
  readonly nonInteractive?: boolean;  // fail-fast on auth_required (local-bridge)
  readonly signal?: AbortSignal;      // HTTP: end-to-end abort. local-bridge: TRANSPORT RESET
}
```

## health() probe — control-plane readiness

`health()` validates the JSON-RPC channel can carry the read calls
`createNexusPermissionBackend` will make. **It does NOT prove audit/fs
writes will succeed** — those data-plane failures surface on first real call.

Sequence: `version` → `read(<path>)` for each `readPaths` (default:
`koi/permissions/{version,policy}.json`). Returns:

| status | meaning |
|---|---|
| `"ok"` | reachable + every probe path returned a valid 200 |
| `"version-only"` | `readPaths: []` — version probed, no policy reads attempted |
| `"missing-paths"` | reachable, one or more reads returned 404 (namespace absent) |

A caller checking `status === "ok"` gets fail-closed behavior by default —
`"missing-paths"` is a distinct discriminator, not a boolean-truthy "ok".
404 is collected per-path (`notFound[]`); transport/5xx/auth/malformed-payload
return `Result.error`.

Default deadline: `HEALTH_DEADLINE_MS = 5_000` ms per probe call. Override
via `NexusHealthOptions.probeDeadlineMs`. The runtime threads
`config.nexusProbeDeadlineMs` here so operators have a single observable
startup-budget knob.

## Production-boundary assertions

- `assertHealthCapable(t)` — throws if `t.health` is missing. Used at the
  HTTP probe site so a non-HealthCapable HTTP transport fails loud at startup.
- `assertProductionTransport(t)` — throws if `t.kind` is missing. Required
  at the runtime boundary unless the operator opts out of both Nexus
  consumers (`nexusPermissionsEnabled=false AND nexusAuditEnabled=false`).
  Library code MUST NOT call this itself — runtime-factory is the only caller.

## extractReadContent — canonical payload validator

```typescript
import { extractReadContent } from "@koi/nexus-client";

const r = extractReadContent(value); // accepts string OR { content: string }
if (r.ok) parse(r.value);
```

Permission backend, audit sink, and `health()` probe all use this same
function — sharing the extractor closes the false-negative gap where a 200
with malformed payload would pass a probe but fail the consumer's parse.

## Retry policy

Read-only methods (`read`, `list`, `grep`, `search`, `stat`, `exists`, `glob`,
`is_directory`, `permissions.check`, `permissions.checkBatch`, `revocations.check`,
`revocations.checkBatch`, `version`) are retried up to `retries` times with
exponential backoff + 20% jitter. Write methods are not retried (non-idempotent).

## Error semantics

Returns `Result<T, KoiError>` — never throws. Network timeouts map to
`code: "TIMEOUT"`, HTTP 5xx to `code: "INTERNAL"`, HTTP 4xx to `code: "EXTERNAL"`,
JSON-RPC errors to their mapped code. All errors carry `retryable` flag.
